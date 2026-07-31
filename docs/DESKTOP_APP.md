# The desktop app: Tauri, Rust, and everything that went wrong

Written for someone who knows the FinalRound architecture but has never touched
Rust or shipped a cross-platform desktop app. No Rust knowledge assumed.

---

## 1. What the desktop app actually is

FinalRound is a web app: a Next.js frontend, a FastAPI backend, MongoDB, Redis,
Piston, and an inference engine — six or seven containers driven by
`docker-compose.local.yml`.

The desktop app is **not a rewrite of any of that**. It is a small native
program whose entire job is:

1. Put the stack's source files on the user's disk.
2. Make sure Docker is installed and usable.
3. Run `docker compose up -d`.
4. Wait until the backend and frontend answer.
5. Show `http://localhost:3000` in a window.

That's it. It's a launcher with a progress bar. The interview itself is the same
web app you already know, running on the user's own machine instead of a server.

We call this program "the shell" or "the supervisor" in the code.

```
┌─ FinalRound.app / .AppImage / .exe ──────────────────┐
│                                                       │
│  Native window (Tauri)                                │
│    ├── splash screen: desktop/src/index.html          │
│    └── after startup: loads localhost:3000            │
│                                                       │
│  Native logic (Rust)                                  │
│    ├── extract runtime → ~/.finalround                │
│    ├── check/install Docker                           │
│    ├── docker compose up -d   ──────────┐             │
│    └── poll until healthy               │             │
└─────────────────────────────────────────┼─────────────┘
                                          ▼
                        ┌─ Docker containers (the real app) ─┐
                        │  frontend :3000   backend :8080    │
                        │  mongo  redis  piston  vllm/ollama │
                        └────────────────────────────────────┘
```

---

## 2. Why Tauri, and what it is

To ship a desktop app you need a window, and something to draw in it. Our UI is
already HTML, so we want a window that renders HTML.

**Electron** is the famous way to do this: it bundles an entire copy of Chrome
into your app. That works, but every app is ~150 MB before you write a line of
code, and it uses a lot of memory.

**Tauri** does the same job by using the web browser *already installed on the
operating system* — WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux.
Nothing to bundle, so the app is small. Our AppImage is 76 MB, and most of that
is the Linux GTK libraries, not our code.

The trade-off, which matters later: because Tauri borrows the system's browser,
**your app depends on libraries that are already on the user's machine**. That's
where several of our bugs came from.

Tauri apps have two halves:

| Half | Language | Our files | What it does |
|---|---|---|---|
| Frontend | HTML/JS | `desktop/src/index.html`, `main.js` | The splash screen: logo, progress bar, error text, buttons |
| Backend | **Rust** | `desktop/src-tauri/src/*.rs` | Everything the browser isn't allowed to do: run programs, read/write files, install software |

The browser half cannot run `docker compose` — web pages can't execute programs,
for good reason. So anything involving the operating system has to live in the
Rust half. **That is the only reason there is Rust in this project.** We didn't
choose Rust for performance or safety; it's simply the language Tauri's native
half is written in.

The two halves talk through **commands**. Rust marks a function as callable:

```rust
#[tauri::command]              // "the frontend may call this"
pub async fn start_stack(app: AppHandle) -> Result<String, StartupError> {
    // ... do the work ...
}
```

and JavaScript calls it by name:

```js
const url = await invoke("start_stack");   // returns, or throws
window.location.replace(url);              // show the running app
```

`invoke` is an ordinary promise. If the Rust function returns an error, the
promise rejects and our `catch` block renders the message on the splash screen.

---

## 3. The Rust you need to read, in four files

1325 lines total. You do not need to write Rust to follow it.

| File | Lines | Job |
|---|---|---|
| `main.rs` | 6 | Program entry point. Calls `run()`. Ignore it. |
| `lib.rs` | 17 | Lists which functions the frontend may call. |
| `tools.rs` | 219 | Finds programs (`docker`, `curl`, `tar`) on disk. |
| `installer.rs` | 478 | Installs Docker / Ollama; decides whether Docker is usable. |
| `supervisor.rs` | 605 | The startup sequence: extract, check, compose up, wait, seed. |

### Rust syntax you'll hit immediately

```rust
fn free_gib(path: &Path) -> Option<u64>
```
A function named `free_gib`, taking a file path, returning **either** a number
**or** nothing. `Option<T>` is Rust's "maybe" — it replaces returning `null`.
The compiler forces you to handle the empty case, which is why you see a lot of
`match` and `if let`.

```rust
-> Result<(), String>
```
Returns **either** success (carrying nothing, `()`) **or** an error message.
`Result` is how all our fallible steps report failure.

```rust
let repo = find_repo()?;
```
The `?` means "if that returned an error, stop this function and pass the error
up." It's shorthand that keeps the happy path readable.

```rust
//!  ...comment at the top of a file
///  ...comment above a function
```
Documentation comments. Every file in `src-tauri/src/` opens with one explaining
why it exists — start there when reading.

That's genuinely enough to follow all 1325 lines.

---

## 4. The startup sequence

`supervisor.rs` → `start_stack()`, in order. Each step emits a progress message
that appears on the splash screen.

| # | Step | Notes |
|---|---|---|
| 1 | Find the runtime | A dev checkout if you're running from the repo; otherwise extract the bundled copy to `~/.finalround` |
| 2 | Generate `backend/.env` | Random JWT secret. Compose refuses to start without this file |
| 3 | Check prerequisites | Docker installed? Running? Reachable by this user? Compose present? |
| 4 | Check disk space | Needs ~12 GB free; fails fast instead of dying mid-download |
| 5 | Detect the engine | `scripts/detect_engine.sh` picks vLLM (NVIDIA), Ollama (Apple Silicon) or Gemini |
| 6 | Register Ollama models | Apple Silicon only — a fresh Ollama has no models |
| 7 | `docker compose up -d` | With `--profile gpu` when applicable |
| 8 | Poll until healthy | Backend `/health`, then a real 200 from the frontend |
| 9 | Seed coding problems | One-time, idempotent |
| 10 | Return the URL | The splash navigates the window to `localhost:3000` |

---

## 5. Why cross-platform desktop work is hard

Three ideas explain almost every bug we hit.

### 5.1 A GUI app does not get your shell's `PATH`

When you type `docker` in a terminal, the shell searches the directories in
`$PATH`. Your terminal's `PATH` is built by your shell profile
(`.bashrc`, `.zshrc`).

**An app launched by double-clicking never reads those files.** On macOS,
launchd gives GUI apps a bare `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin`. Docker
Desktop installs its CLI to `/usr/local/bin/docker` — *not* in that list. So:

- In your terminal: `docker` works.
- Inside the app: `docker` does not exist.

Same machine, same user, different answer. This one bug wore three different
disguises for us (see §6.2, §6.6).

The fix is to never search `PATH` alone. `tools.rs` searches `PATH` **and** a
list of known absolute locations, and hands children an expanded `PATH`:

```rust
pub fn find(name: &str) -> Option<PathBuf>   // absolute path, or None
```

### 5.2 "Installed" is not one question

For Docker there are at least four distinct states, and they need different fixes:

| State | Right response |
|---|---|
| Binary not on disk | Install Docker |
| Binary present, daemon stopped | Start Docker |
| Both fine, user not in `docker` group | Grant group access |
| Engine fine, **Compose plugin missing** | Install Compose |

A single "does `docker info` succeed?" check collapses all four into one
failure, and then any fix you offer is wrong three times out of four. That is
literally what caused our infinite loop (§6.3).

### 5.3 A fresh machine has almost nothing

Our dev box has years of accumulated tooling. A real user's machine does not.
Measured on a stock `ubuntu:24.04`:

| Tool | Present? |
|---|---|
| `tar`, `gzip`, `bash`, `awk`, `id`, `groupadd` | yes |
| `curl` | **no** |
| `wget` | **no** |
| `gnupg` | **no** |
| CA certificate bundle | **no** — so *all HTTPS fails* |
| `docker`, `docker compose` | **no** |
| `docker` group | **no** |
| NVIDIA Container Toolkit | **no** |

Every assumption in that column cost us a release cycle. The lesson we adopted:
**prefer removing a dependency over detecting it.** Bundling the runtime was
better than checking for `curl`, because it means `curl` no longer matters.

---

## 6. Every bug we hit, and the actual fix

### 6.1 `PREPAI_HOME` — the app had no code to run

**Symptom:** `Could not find docker-compose.local.yml. Set PREPAI_HOME to the repo.`

The shell only launches the stack; it doesn't contain it. It searched upward from
its own location for `docker-compose.local.yml`. On the dev machine that finds
the repo. On a user's machine there is no repo, so it gave up.

**Fix, in two rounds.** First we made it download the source tarball from GitHub
at first launch. That worked, but depended on `curl` and a network. So we
replaced it with **bundling**: `desktop/bundle-runtime.mjs` builds a 222 KB
`runtime.tar.gz` at compile time, Tauri ships it inside the installer, and the
app extracts it to `~/.finalround` on first run. No network, no `curl`, and the
app can never run a runtime from a different version than itself.

> While writing the bundle filter I excluded any directory named `models`, which
> silently dropped `backend/models/` — real Python source the backend imports.
> Anchoring the excludes to exact paths (`ollama/models`) fixed it. Caught only
> because we listed the archive contents instead of trusting the build.

### 6.2 `failed to run curl: No such file or directory (os error 2)`

**Symptom:** instant failure on a fresh Linux machine.

`os error 2` is ENOENT: the operating system could not find a program called
`curl`. Two possible causes, and they're indistinguishable from the error alone
— either `curl` isn't installed, or it isn't on the `PATH` this process was
given (§5.1).

**Fix:** all three. Try `curl`, fall back to `wget`, and since bundling landed,
neither is needed for startup at all. Where the *installer* still needs a
downloader, it installs one first.

### 6.3 The infinite "installing… restart… installing…" loop

**Symptom, on macOS:** clicking *Install Docker* opened Docker Desktop, sat for
two minutes, timed out. Restarting produced "Docker is installed, not started",
which produced the same loop forever.

**Two stacked causes.**

*Detection.* `docker_ready()` ran `docker info` and treated any failure as "not
running". On a GUI-launched Mac app, `docker` isn't on `PATH`, so it could never
succeed — no matter how many times Docker Desktop was started.

*Fix strategy.* Even with detection fixed, on Linux the remaining failure is a
permissions one: your account was just added to the `docker` group, but a
process's group list is fixed at login, so the running app still can't use the
socket. Our message said "restart the app," which is false — restarting from the
same desktop session inherits the same group list.

**Fix:** a proper four-way state (§5.2), plus `sg`:

```
sg docker -c "docker compose ... up -d"
```

`sg` re-executes a command with an extra group, reading `/etc/group` at exec
time rather than inheriting the caller's stale list. So a group granted thirty
seconds ago works immediately — **no logout, no reboot**. Verified in a clean
container: right after `usermod -aG docker tester`, `sg docker -c "id -nG"`
reports `docker tester`.

And where nothing the app can do would help, it now shows **no button at all**,
just the honest instruction. A button that re-runs the same failing fix *is* the
loop.

### 6.4 `usermod: group 'docker' does not exist`

The setup ran `usermod -aG docker "$(logname)"` without ensuring the group
existed. Docker's installer normally creates it; if the install partly failed,
it doesn't. Reproduced in `debian:12-slim`:

```
OLD: usermod: group 'docker' does not exist
NEW: OK: tester is now in: tester docker
```

**Fix:** `groupadd -f docker` first (`-f` = succeed if it already exists). Also
replaced `logname` — which needs a controlling terminal a GUI app doesn't have —
with `PKEXEC_UID`, the variable `pkexec` exports for exactly this purpose.

### 6.5 `docker: unknown command` + a wall of usage text

**Symptom:** `docker compose up` printed Docker's help page.

Docker Compose v2 is a **plugin**, shipped separately from the engine.
`apt install docker.io` gives you the engine with no plugin, so `docker compose`
is an unrecognised subcommand. Our code assumed the plugin always exists.

**Fix:** resolve Compose at runtime — try `docker compose`, fall back to a
standalone `docker-compose` binary, and if neither exists say so specifically.
The installer now installs the plugin, falling back to Docker's official plugin
binary when the distro package isn't available.

**And the bug behind the bug.** `install_docker()` began with:

```rust
if docker_ready() { return Ok(...ready: true...); }   // WRONG
```

On a machine with a working engine but no Compose, that returned success and
**never ran the script that installs Compose**. The UI retried, Compose was
still missing, forever. The check now requires *both* halves:

```rust
if docker_ready() && compose_prefix().is_some() { ... }
```

Compounding it, the splash screen hardcoded "Docker isn't installed" for that
branch and ignored the backend's actual message — so a user whose Docker was
perfectly fine was told Docker was missing. The UI now always leads with the
message the Rust side sent.

### 6.6 macOS: Docker installed, app says otherwise

Docker Desktop 4.18+ installs its CLI to `~/.docker/bin` and adds that to `PATH`
via a shell profile — which a GUI app never reads (§5.1). If the user chose the
per-user install, `/usr/local/bin/docker` doesn't exist either.

**Fix:** search `~/.docker/bin` and Docker.app's internal `bin` too. Also
removed an elevated call to `.../MacOS/Docker --accept-license` — the documented
binary is `.../MacOS/install`, and running Docker as root leaves root-owned
files in `~/.docker` that break the user's later commands.

### 6.7 macOS: Ollama with no models

`ollama_ready()` checked only that port 11434 answered. A freshly installed
Ollama answers on that port with **zero models**, so the backend would request
model `interviewer` and fail every turn.

**Fix:** register the models the way `setup_local.sh` does — fetch the adapter,
`ollama create` both tags.

That needed the `ollama` CLI, which I initially assumed the user had to install
manually from Ollama's UI. **I checked instead of guessing:** downloaded the
real `Ollama-darwin.zip` and inspected it. The CLI is
`Ollama.app/Contents/Resources/ollama` — a 65 MB universal binary, mode `0755`,
shipped inside the bundle. So it's always there after our install and no manual
step is needed.

> That inspection also revealed `ollama.png` sitting beside `ollama` in the same
> directory. Our binary lookup only checked "is this a file", so a same-named
> data file could have been returned and then failed at exec. It now requires
> the executable bit.

### 6.8 `could not select device driver "nvidia"`

`detect_engine.sh` chose vLLM whenever `nvidia-smi` reported a GPU. But
`nvidia-smi` proves the *host* driver works — it says nothing about whether
**Docker** can pass the GPU into a container. That needs the NVIDIA Container
Toolkit, which we never installed and never checked for.

**Fix:** the app probes Docker's runtimes and passes the answer to the detector.
No toolkit means fall back to Gemini with a logged reason, rather than a compose
crash. The installer now installs the toolkit when a driver is present but
Docker can't see it.

**Deliberately not automated:** the GPU driver itself. It compiles a kernel
module, needs a reboot, and a failed attempt wedges the package manager — which
happened to us (§6.9). The download page documents it instead.

### 6.9 `nvidia-dkms-570 … exited with status error 10`

**Symptom:** installing our `.deb` failed on an unrelated NVIDIA package.

Not our package. A failed dkms kernel-module build leaves dpkg with a
half-configured package, and in that state **every** apt operation fails —
including the one our `.deb` triggers, and the manual Docker install attempted
earlier on that machine (which is why Docker was genuinely missing).

**Fix:** the setup now checks dpkg health *first*, attempts the safe repair
(`dpkg --configure -a`), and if the machine is still broken stops with the stuck
package names and exact recovery commands — instead of failing three minutes
later from an unrelated step.

### 6.10 No CA certificates: all HTTPS silently impossible

Confirmed on stock `ubuntu:24.04`: no CA bundle, so
`curl https://get.docker.com` fails with `error setting certificate file`. No
`gnupg` either, so the NVIDIA repo key couldn't be dearmored and apt quietly
refused the repo.

**Fix:** install `curl`, `ca-certificates` and `gnupg` before anything needs
them, then verify. Post-fix on a bare container: `get.docker.com` returns **200**
and `gpg --dearmor` succeeds.

### 6.11 The frontend was running in development mode

Every page was slow because the container's only command was `npm run dev` —
unminified, recompiling each route on first visit. `docker-compose.local.yml`
now builds and serves a production build. Landing-page JS dropped ~324 KB →
~184 KB gzipped, alongside removing 14 `backdrop-blur` layers that were
re-filtering every frame over an animated WebGL background.

### 6.12 The cloud site always showed "local mode"

`NEXT_PUBLIC_*` variables are **inlined by Next.js at build time**, not read at
runtime. The cloud image is built by `frontend/Dockerfile.prod`, which never
passed `NEXT_PUBLIC_DEPLOYMENT` — so the value baked in as `local`, and no
runtime environment change could fix it.

**Fix:** the backend exposes `GET /config` reporting the engine it is actually
configured for, and the frontend asks on load. The build-time value is only the
first-render guess. Keying off capability rather than a label also means a
GPU-less desktop install correctly shows the Gemini-only UI.

### 6.13 AppImage: `Cannot mount AppImage, please check your FUSE setup`

An AppImage is a self-mounting filesystem image and needs **libfuse2**. Ubuntu
22.04+ ships only FUSE 3. This fails before any of our code runs, so we can't
fix it in the app.

**Fix:** the `.deb` is now the primary Linux download — it declares its
dependencies (`libwebkit2gtk-4.1-0`, `libgtk-3-0`) so apt resolves them — with
the AppImage as an alternative plus the `sudo apt install libfuse2` note.

---

## 7. Building and releasing

```bash
cd desktop
npm install
npm run tauri dev      # run from source, hot-reloads the splash
npm run tauri build    # produce installers
```

`tauri build` runs `node bundle-runtime.mjs` first (via `beforeBuildCommand`),
which regenerates `runtime.tar.gz`. Output lands in
`src-tauri/target/release/bundle/`.

**Each OS can only build its own installers** — macOS won't produce a `.exe`,
Linux won't produce a `.dmg`. That's why releases go through CI
(`.github/workflows/desktop-release.yml`), which builds on all three runners in
parallel:

```bash
git tag desktop-v0.1.2
git push origin desktop-v0.1.2      # CI builds and publishes the release
```

The download page links to `releases/latest/download/FinalRound_<version>_*`,
so it picks up new releases with no code change — but the version in
`tauri.conf.json` must match the version in
`frontend/src/app/download/page.tsx`, because Tauri stamps it into the filenames.

**Testing tip that saves 20 minutes per iteration:** you don't need a release to
test. Because the runtime is bundled, a locally built `.deb` is a faithful copy
of what CI will publish. Build it, copy it to the test machine, install. Only
cut the release once it works.

---

## 8. Signing (the one thing still unsolved)

Our installers are unsigned, so:

- **macOS** refuses to open the app: *"cannot be verified."* Workaround:
  right-click → Open, or `xattr -cr /Applications/FinalRound.app`.
- **Windows** SmartScreen warns "unrecognized app." Workaround: More info →
  Run anyway.

Fixing this properly requires an Apple Developer account (~$99/yr) for
notarization and a Windows code-signing certificate. Until then both are
documented on the download page as expected first-launch steps.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **Tauri** | Framework for desktop apps that renders HTML in the OS's own browser engine |
| **Rust** | The language Tauri's native half is written in — that's the only reason it's here |
| **crate** | A Rust package. `Cargo.toml` lists ours; we deliberately use only `tauri` + `serde` |
| **`#[tauri::command]`** | Marks a Rust function as callable from JavaScript |
| **`invoke("name")`** | JavaScript calling such a function; returns a promise |
| **`Result` / `Option`** | Rust's "success or error" and "value or nothing"; replace exceptions and `null` |
| **`?`** | "If this failed, return the error from here" |
| **ENOENT / `os error 2`** | The OS could not find the file or program you asked to run |
| **`PATH`** | Directories the OS searches for programs. **A GUI app's `PATH` is not your terminal's** |
| **`pkexec`** | Linux "ask for admin rights" prompt (the graphical `sudo`) |
| **`sg`** | Run a command with an extra group, read fresh from `/etc/group` — avoids re-login |
| **dkms** | Rebuilds kernel modules (e.g. NVIDIA) per kernel. Fails → dpkg wedged |
| **AppImage** | Single-file Linux app; self-mounts, so it needs libfuse2 |
| **`.deb`** | Debian/Ubuntu package; declares dependencies so apt installs them |
| **Compose plugin** | `docker compose` as a plugin to the Docker CLI, packaged separately from the engine |
| **NVIDIA Container Toolkit** | Lets Docker pass a GPU into a container. Separate from the GPU driver |
