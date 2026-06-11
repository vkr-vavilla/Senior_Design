# Scaling & Optimization Plan — PrepAI / FinalRound

How this app behaves under load, where the real bottlenecks are, and a prioritized
plan to optimize each tier. Numbers below come from the live vLLM startup logs and
`nvidia-smi` on the dev box (1× RTX 4090), plus the actual query patterns in `backend/`.

---

## 0. TL;DR — where the bottleneck actually is

For this app, ranked by how hard each tier is to scale:

1. **LLM inference (vLLM / Gemini)** — by far the dominant cost. ~32 concurrent
   interviews per RTX 4090 today.
2. **Stateful WebSockets** — interview state lives in backend RAM; blocks clean
   horizontal scaling.
3. **TTS (Kokoro)** — CPU-bound, ~50–100 synth calls per interview.
4. **MongoDB** — the *lightest* load. A single replica set handles ~1M daily users
   without sharding.

> Key takeaway for the design review: you scale this app by **squeezing LLM serving
> and making the backend stateless**, not by sharding MongoDB. Sharding is premature.

---

## 1. Request profile — what one interview costs

A ~20-minute interview is a burst, not a single request:

| Work | Count per interview | Hits |
|---|---|---|
| LLM generations (Alex turns) | ~20–30 | vLLM / Gemini |
| TTS synthesize calls | ~50–100 (one per clause) | Kokoro (CPU in backend) |
| WebSocket | 1 long-lived conn, hundreds of streamed chunks | backend |
| MongoDB reads | ~3–5 | Mongo |
| MongoDB writes | ~2–3 | Mongo |
| Generated tokens | ~3,000–4,500 output tokens | vLLM / Gemini |

---

## 2. Current inference footprint (RTX 4090, measured)

`gpu_memory_utilization 0.90` → vLLM claims **21.28 GiB** of the 23.65 GiB usable.

| Component | VRAM | Note |
|---|---|---|
| Model weights | 5.20 GiB | Qwen2.5-7B at AWQ 4-bit (~15 GiB at fp16) |
| PyTorch activations (peak) | 4.14 GiB | forward-pass scratch |
| **KV cache** | **11.86 GiB** | the concurrency budget — 13,875 paged blocks |
| Non-torch overhead | 0.08 GiB | |
| **Total** | **~21.3 GiB** | nearly the whole card |

- LoRA adapter (`interviewer`, rank 64): a few hundred MB on top — negligible.
- Concurrency cap: `--max-num-seqs 32` → **~32 concurrent interviews / GPU**.
- KV-bound ceiling: **9.03×** *only if* every request used the full 24,576-token
  window; real interviews (~6–10k tokens) hit the 32-seq cap first.
- Throughput: ~50–100 tok/s single-stream; several hundred to ~1,000+ tok/s aggregate
  with continuous batching. **Benchmark to confirm — do not quote without measuring.**

**Minimum hardware to run at all:** floor is weights 5.2 + activations ~4.1 ≈ 9.3 GiB,
so a 12 GB card runs it with a small `max-model-len`/`max-num-seqs`. The current config
(24k context, 32 seqs) needs the full 24 GB — the 4090 is right-sized.

---

## 3. LLM / vLLM optimizations (highest impact)

The KV cache (11.86 GiB) is what caps concurrency. Shrink the per-request KV footprint
→ fit more users on the same GPU. Levers, ranked:

### 3.1 Prefix caching — biggest easy win  ⭐
Flag: `--enable-prefix-caching` (currently **off**).
The system prompt (resume + JD + Alex persona) is long and **identical on every turn**.
Prefix caching computes its KV once and reuses it instead of recomputing each turn.
Large throughput + latency win for a fixed-prompt chat app.

### 3.2 KV-cache quantization — ~2× concurrency
Flag: `--kv-cache-dtype fp8`.
Stores the cache in fp8 instead of fp16, ~halving the 11.86 GiB → roughly double the
concurrent interviews (or longer context) for a small quality hit. The 4090 (Ada)
supports fp8 natively.

### 3.3 Right-size `--max-model-len` — concurrency vs context
Currently 24,576 (set to stop an overflow crash). A real interview is ~6–10k tokens.
Dropping to ~12k–16k frees KV cache for more simultaneous users while still fitting a
full interview. Direct trade: more context per request = fewer requests per GPU.

### 3.4 CUDA graphs — remove `--enforce-eager` (test first)
`--enforce-eager` disables CUDA-graph capture; removing it cuts per-token kernel-launch
overhead (~10–20%) and unblocks async output processing (logs warn about this). Caveat:
graphs + LoRA + awq_marlin can be finicky — verify it still loads before keeping it.

### Already optimized (name these in the report)
- **AWQ 4-bit quantization** — weights 5.2 GiB instead of ~15 GiB at fp16.
- **PagedAttention + continuous batching** — vLLM does this automatically; the core
  reason it serves far more concurrency than naive inference.

**Combined #3.1–#3.3 target:** ~32 → 100+ concurrent on the same 4090, cutting the
GPU fleet for a given DAU by ~3–4×.

---

## 4. MongoDB optimizations

### 4.1 Indexes to add (the real "query performance" answer)
Today only `leetcode` is indexed; the hot app queries do full collection scans.

```js
// Every login/register: find_one({email}). Unindexed = full scan per login.
db.users.createIndex({ email: 1 }, { unique: true })

// History page: find({user_id}).sort({created_at: -1}) — compound serves filter+sort.
db.interviews.createIndex({ user_id: 1, created_at: -1 })
```

Everything else (`find_one({_id})` in chat/coding/feedback) rides MongoDB's automatic
`_id` index. `leetcode` already has slug (unique), difficulty, tags, and a text index.
The `unique` on email also prevents duplicate accounts at the DB layer.

### 4.2 Replica set (you already have this on Atlas)
Same data on 3+ nodes: one **primary** (writes) + **secondaries** (synced copies).
- **Failover/HA:** primary dies → a secondary is auto-promoted in seconds.
- **Read scaling:** offload heavy reads (history, analytics) to secondaries via
  `readPreference=secondaryPreferred`.
- This is replication (duplicate data for safety), **not** sharding (split data for size).
- Atlas runs every paid cluster as a 3-node replica set by default → mostly handled.

### 4.3 Sharding (only when needed — not yet)
Needed only when the working set outgrows one machine's RAM or one primary can't absorb
the write rate. At ~1M DAU this app does ~12 writes/s avg, ~50/s peak — trivial for one
replica set. If you ever shard:
- Good shard key for `interviews` / `chat_sessions`: **hashed `user_id`** — spreads users
  evenly, keeps a user's data co-located.
- **Avoid** `created_at` or raw `_id`/ObjectId as shard keys — monotonically increasing →
  every new write hotspots one shard.
- Never shard `leetcode` (~4k docs) — just replicate it.

---

## 5. Backend / WebSocket: make it stateless

The interview WebSocket (`backend/routers/chat.py::chat_ws`) keeps conversation state in
backend RAM:

```python
messages = [{"role": "system", "content": system_prompt}]  # grows every turn
history  = []                                                # grows every turn
```

This is **stateful**: the whole interview lives in one process until the connection
closes and it's saved to Mongo.

**Why it blocks scaling:** with N backend replicas behind a load balancer, a given
interview is pinned to the one replica holding its `messages`/`history`. The LB needs
sticky sessions, and if that replica dies mid-interview the unsaved transcript is lost.

**Fix — externalize session state to Redis:**
- Store `messages`/`history` per interview in Redis instead of process memory.
- Any replica can then handle any message → true horizontal scaling with interchangeable
  backend pods; a crash no longer loses the conversation.
- Bonus: also the right place to put the Redis-backed prefix/session caches.

---

## 6. Capacity math at 1M daily active users

1M **daily** ≠ 1M **concurrent**. One 20-min interview/user/day, spread over a day:

- Avg concurrent ≈ 1M × (20 / 1440) ≈ **~14,000**
- Peak (~4× lumpier) ≈ **~55,000 concurrent**

Per tier at peak:

| Tier | Load at peak | Verdict |
|---|---|---|
| MongoDB | ~50 writes/s, few hundred reads/s | One replica set, easily. No sharding. |
| Backend WS | ~55k concurrent connections | ~20–50 stateless replicas + LB + Redis |
| TTS | ~55k × clause rate | Move Kokoro to a dedicated service / API |
| **LLM** | ~55k concurrent generations | **The wall** — see below |

**LLM is the cost driver:** 55,000 ÷ 32 ≈ **~1,700 GPUs** at today's per-GPU concurrency.
Options: (a) lean on a hosted API (Gemini/OpenAI) that autoscales + batches for you, or
(b) rent serverless GPUs. The §3 optimizations (→100+ concurrent/GPU) cut this to the
low hundreds of GPUs.

---

## 7. Prioritized action plan

### Quick wins (hours, low risk)
- [ ] Add the two MongoDB indexes (§4.1) — ideally as a startup hook so they self-create.
- [ ] Add `--enable-prefix-caching` to the vLLM service (§3.1).
- [ ] Right-size `--max-model-len` to ~12k–16k (§3.3).
- [ ] Benchmark real tokens/sec + max stable concurrency to replace the §2 estimate.

### Medium (days)
- [ ] Add `--kv-cache-dtype fp8`, re-check the KV-cache size + concurrency in startup logs (§3.2).
- [ ] Test removing `--enforce-eager` for CUDA graphs; keep only if it still loads cleanly (§3.4).
- [ ] Set `readPreference=secondaryPreferred` for history/analytics reads (§4.2).

### Bigger lifts (when you actually approach scale)
- [ ] Move WebSocket `messages`/`history` into Redis; make the backend stateless (§5).
- [ ] Put the backend behind a load balancer; run multiple replicas.
- [ ] Move TTS to a dedicated service (GPU or hosted streaming TTS).
- [ ] Decide LLM serving strategy: hosted API vs self-hosted GPU fleet (§6).
- [ ] Only if data volume demands it: shard `interviews`/`chat_sessions` on hashed `user_id` (§4.3).

---

## 8. Deployment context

The same `docker-compose.yml` serves both a GPU box (local vLLM) and a Gemini/AWS box,
via the `gpu` Compose profile — see [README → Run with Docker](../README.md#3-run-with-docker-recommended).
The vLLM tuning flags in §3 go in the `vllm` service `command:` block.

---

## 9. Self-hosted MongoDB replica set — learning experience

> **Why this is here:** production uses **MongoDB Atlas**, which *is* a managed, secured,
> externally-reachable 3-node replica set — so we never have to build one. This section
> documents standing up our **own** replica set in Docker as a hands-on exercise: to
> actually see member election, failover, and `rs.status()` instead of trusting Atlas to
> do it invisibly. It is a learning lab, **not** the production path.

### 9.1 What a replica set is (recap)
Three `mongod` members holding the **same** data, sharing a **keyfile** (member-to-member
auth) and a set name (`rs0`). One `rs.initiate()` ties them together. Three = minimum odd
count so a primary can be elected if one dies. Replication = duplicate data for HA/read
scaling; it is **not** sharding (which splits data for size — see §4.3).

### 9.2 Network finding (this dev box)
- Host LAN IP: **`192.168.1.33`** on `enp69s0` (**wired ethernet**; the WiFi adapter `wlo2`
  is down).
- The `192.168.1.x/24` range = behind our **own router**, not a raw isolated campus subnet.
- **Peer-to-peer confirmed working** — `ping` + `nc -zv 192.168.1.33 <port>` from another
  LAN machine succeeded, so **no client isolation**. A cross-machine / LAN-reachable
  replica set is viable here. (On locked-down campus WiFi with client isolation it would
  not be — fallback would be all-on-one-machine or a Tailscale/ZeroTier overlay.)
- That IP is a **dynamic DHCP lease** → set a **DHCP reservation** on the router before
  pointing connection strings at it, or a reboot will move it.

### 9.3 Compose file — 3-node set on one host
`docker-compose.mongo.yml`:

```yaml
services:
  mongo1:
    image: mongo:7
    command: ["--replSet","rs0","--keyFile","/etc/mongo-keyfile","--bind_ip_all"]
    ports: ["27017:27017"]
    volumes:
      - mongo1-data:/data/db
      - ./mongo-keyfile:/etc/mongo-keyfile:ro
  mongo2:
    image: mongo:7
    command: ["--replSet","rs0","--keyFile","/etc/mongo-keyfile","--bind_ip_all"]
    ports: ["27018:27017"]
    volumes:
      - mongo2-data:/data/db
      - ./mongo-keyfile:/etc/mongo-keyfile:ro
  mongo3:
    image: mongo:7
    command: ["--replSet","rs0","--keyFile","/etc/mongo-keyfile","--bind_ip_all"]
    ports: ["27019:27017"]
    volumes:
      - mongo3-data:/data/db
      - ./mongo-keyfile:/etc/mongo-keyfile:ro
volumes:
  mongo1-data:
  mongo2-data:
  mongo3-data:
```

`--keyFile` enables **both** member-to-member auth and client login auth (no separate
`--auth` needed).

### 9.4 Bootstrap steps (one-time)

```bash
# (a) Shared keyfile. The mongo image runs as uid 999, so it must own the file.
openssl rand -base64 756 > mongo-keyfile
chmod 400 mongo-keyfile
sudo chown 999:999 mongo-keyfile

# (b) Start all three members
docker compose -f docker-compose.mongo.yml up -d

# (c) Initiate the set. Advertise members on the LAN IP (192.168.1.33) + the published
#     ports, so OTHER machines on the network can reach the members the driver returns.
#     (If you only ever connect from THIS host, container names mongo1/2/3:27017 also work.)
docker compose -f docker-compose.mongo.yml exec mongo1 mongosh --eval '
  rs.initiate({
    _id: "rs0",
    members: [
      { _id: 0, host: "192.168.1.33:27017" },
      { _id: 1, host: "192.168.1.33:27018" },
      { _id: 2, host: "192.168.1.33:27019" }
    ]
  })'

# (d) Create the admin user (localhost exception allows this before any user exists)
docker compose -f docker-compose.mongo.yml exec mongo1 mongosh --eval '
  admin = db.getSiblingDB("admin");
  admin.createUser({
    user: "appuser",
    pwd: "STRONG_PASSWORD_HERE",
    roles: [{ role: "root", db: "admin" }]
  })'
```

### 9.5 Connect

```bash
# Point the app at the self-hosted set (replaces the Atlas URI in backend/.env)
MONGODB_URI=mongodb://appuser:STRONG_PASSWORD_HERE@192.168.1.33:27017,192.168.1.33:27018,192.168.1.33:27019/FinalRound?replicaSet=rs0&authSource=admin
```

### 9.6 Things to actually try (the point of the lab)
```js
rs.status()            // see PRIMARY + 2 SECONDARY, election state
rs.conf()              // the member config you set in 9.4
db.hello().isWritablePrimary
```
- **Kill the primary** (`docker compose -f docker-compose.mongo.yml stop mongo1`) and watch
  a secondary auto-promote within seconds via `rs.status()` from another member — that's the
  failover/HA you otherwise pay Atlas for.
- Write on the primary, read from a secondary (`readPreference=secondaryPreferred`) to see
  replication and read scaling (§4.2).

### 9.7 The hostname gotcha (why §9.4c uses the LAN IP)
A client connects to one member, then the member hands back the **addresses of all members
from the RS config** and the driver reconnects to the primary using *those*. If you initiate
with docker-internal names (`mongo1:27017`), an external/LAN client is told "primary is at
`mongo1`" — which it **cannot resolve** → fails despite reaching the server. So the member
hosts must be addresses the *client* can reach: `192.168.1.33:<port>` for LAN clients.

### 9.8 Scope & security
- **LAN-only** (teammates/demo on this network): §9.3–§9.5 as-is. Behind our own router this
  is reasonably contained.
- **Internet-facing** (people off the LAN): additionally need router **port-forwarding** for
  27017–27019, **TLS** (`--tlsMode requireTLS` + certs), **firewall source-IP allowlists**, and
  **strong unique passwords**. Exposed MongoDB is heavily bot-scanned — never expose without
  all of these. For real external access, a cloud VM or just Atlas is the saner path.

### 9.9 Why production stays on Atlas
This lab proves the mechanism, but Atlas already gives a hardened, monitored, backed-up,
externally-reachable replica set with automated failover — and sidesteps the school network
entirely (clients connect outbound). The self-hosted set is for **understanding**, not for
carrying real users.
