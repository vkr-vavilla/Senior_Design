# Auto-install Docker + Ollama from the desktop app, and fix the download page

## Context

The desktop app (`desktop/`) is a Tauri shell whose Rust "supervisor"
(`desktop/src-tauri/src/supervisor.rs`) runs `scripts/detect_engine.sh` to pick
an inference engine, then shells out to `docker compose ... up -d`. Today, if
Docker (or, on Apple Silicon, Ollama) isn't installed, `start_stack` just
returns a plain error string and the splash screen shows a generic "Retry"
button — the user is on their own to go install things manually. Given the
target audience (people trying the app, not necessarily developers), that's a
real adoption blocker, which is why we're adding in-app installation.

Separately: the Mac dmg is unsigned (no signing identity in
`tauri.conf.json`, no Apple secrets in `.github/workflows/desktop-release.yml`),
so macOS Gatekeeper will block it on first open. That can't be fixed without
an Apple Developer account and secrets I don't have — it needs to be
documented, not silently left as a mystery "app is damaged" error. At the same
time, the download page's only "how do I actually run this" instructions are
the git-clone/from-source box; there's nothing telling someone who just
downloaded the AppImage or dmg what to actually do with the file.

This plan covers four things:
1. Auto-install Docker on Linux and macOS, invoked from the splash screen.
2. Auto-install Ollama on macOS (the only OS where `detect_engine.sh` picks
   Ollama).
3. Download-page copy: explicit "after you download" run steps per OS,
   including the Gatekeeper workaround for Mac.
4. Fix the packaged app running Next.js dev mode, which is the real cause of
   it feeling slow everywhere (not just the Spline-heavy landing page).

Windows is explicitly out of scope for auto-install (matches what was
proposed and agreed) — it keeps today's plain-error behavior. `detect_engine.sh`
never picks a local engine on Windows anyway (falls to Gemini), but Docker is
still required there for the containerized backend/frontend/mongo/redis/piston,
so the gap is real; just not tackled here.

## Design constraints (carried over from the existing code)

- **No new Rust crates.** `supervisor.rs`'s header explicitly commits to
  "No extra crates... dependency-light and cross-platform" (raw `TcpStream`
  instead of an HTTP client). The installer follows the same rule: downloads
  and installs happen by shelling out to `curl`, `hdiutil`, `ditto`, `pkexec`,
  `osascript` — tools already on the target OS — not by adding `reqwest`, a
  zip crate, or Tauri plugins (`plugin-process`, `plugin-os`).
- **Explicit consent, native elevation.** The user clicks an "Install X"
  button (that's the consent gesture); the actual privilege escalation is the
  OS's own dialog (`pkexec` on Linux, `osascript ... with administrator
  privileges` on macOS) — we never store or prompt for a password ourselves.
- **Linux uses Docker's own installer.** `curl -fsSL https://get.docker.com |
  sh` is Docker's officially documented convenience script and already
  detects the distro (apt/dnf/pacman/zypper/etc.) — reimplementing per-distro
  package-manager logic ourselves would be far more fragile. This will be
  disclosed in the UI copy before the user clicks Install, since "we run a
  remote script as root" deserves to be said out loud even though it's the
  vendor's own standard method.

## Part 1 — Docker/Ollama readiness check (`supervisor.rs`)

Add a `StartupError` enum (replaces the plain `String` error on
`start_stack`) so the frontend can tell "Docker is missing" apart from "Docker
compose failed" apart from other errors:

```rust
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartupError {
    MissingDocker { message: String },
    MissingOllama { message: String },
    Other { message: String },
}
impl From<String> for StartupError {
    fn from(message: String) -> Self { StartupError::Other { message } }
}
```

Because of the blanket `From<String>`, every existing `foo()?` call inside
`start_stack` (`find_repo()?`, `detect_engine(&repo)?`, `compose_up(&repo,
&env)?`) keeps compiling unchanged — those helper functions stay
`Result<_, String>`. Only `start_stack`'s signature
(`Result<String, StartupError>`) and its explicit `Err(...)` sites change.

Insert a prereq check between engine detection and `compose_up`:

```rust
emit(&app, 20, "Checking prerequisites…");
if !installer::docker_ready() {
    return Err(StartupError::MissingDocker {
        message: "Docker isn't installed or isn't running.".into(),
    });
}
if engine == "ollama" && !installer::ollama_ready() {
    return Err(StartupError::MissingOllama {
        message: "Ollama isn't installed or isn't running.".into(),
    });
}
```

`docker_ready()` is `docker info` succeeding (covers "not installed" and
"installed but daemon not running" — mostly relevant on the Mac, where the
binary can be present but Docker Desktop not launched — in one check).
`ollama_ready()` reuses the existing `port_open("127.0.0.1", 11434)` check
already in this file (make `port_open` `pub(crate)` so the new
`installer.rs` module can call it).

## Part 2 — New module `desktop/src-tauri/src/installer.rs`

Two Tauri commands, each returning `Result<InstallOutcome, String>`:

```rust
#[derive(Serialize)]
pub struct InstallOutcome {
    ready: bool,     // true = safe for the frontend to immediately retry start_stack
    message: String, // shown in the UI either way
}
```

**`install_docker`** — dispatches on `cfg!(target_os = ...)`:

- *macOS*: if `/Applications/Docker.app` is missing, `curl` the official dmg
  (`https://desktop.docker.com/mac/main/{arm64,amd64}/Docker.dmg`, arch from
  `cfg!(target_arch = "aarch64")`) to a temp path, `hdiutil attach -nobrowse`,
  then a single `osascript -e 'do shell script "cp -R .../Docker.app
  /Applications/ && .../Docker --accept-license" with administrator
  privileges'` (copy + accept-license in one elevated call), `hdiutil detach`,
  delete the dmg. Then `open -a Docker` and poll `docker_ready()` (same
  poll-loop shape as `start_stack`'s backend/frontend wait) up to ~120s —
  first Docker Desktop launch is slow. No group-membership issue on macOS, so
  once `docker_ready()` is true in-process, return `{ ready: true }`.
  Note: Docker Desktop's own privileged-helper install will still show one
  native Apple authorization dialog on first launch — that's Docker's, not
  ours, and shouldn't be routed around.

- *Linux*: run the get.docker.com script plus group setup through one
  `pkexec sh -c "curl -fsSL https://get.docker.com | sh && usermod -aG docker
  \"$(logname)\" && systemctl enable --now docker"`. **Important subtlety**:
  the *current* (already-running) Tauri process's group list was computed at
  login and won't include the newly-added `docker` group — so even though the
  daemon is genuinely running afterward, a `docker info` call from this same
  process will still fail with a permission error. Don't try to paper over
  this with `sg`/`newgrp` gymnastics (fragile, and it'd force rewriting
  `compose_up`'s clean `Command` builder into a shell-escaped string). Instead
  return `{ ready: false, message: "Docker was installed and started —
  restart PrepAI so your account's new Docker permissions take effect." }`
  once the pkexec call exits successfully. If `pkexec` itself isn't found
  (uncommon on a desktop session, but possible), return a plain `Err` with
  the manual command spelled out (`curl -fsSL https://get.docker.com | sh`) so
  the frontend can show it as copyable text instead of silently failing.

**`install_ollama`** (macOS only; returns `Err` immediately on other OSes,
since `detect_engine.sh` never picks Ollama elsewhere): if
`/Applications/Ollama.app` is missing, `curl` the official zip
(`https://ollama.com/download/Ollama-darwin.zip`), `ditto -x -k` it into
`/Applications` (no elevation needed — `/Applications` is user/admin-group
writable on a personal Mac, matching how a manual drag-install works), then
`open -a Ollama` and poll `port_open("127.0.0.1", 11434)` up to ~30s. Always
`{ ready: true }` — no Linux-style group problem here.

Shared tiny helpers in `installer.rs`: `run_ok(cmd: &mut Command, what: &str)
-> Result<(), String>` (status-check wrapper, same shape used for every shelled-out
step), and a poll-loop helper mirroring `start_stack`'s existing wait pattern.

## Part 3 — Wire-up

- `lib.rs`: add `mod installer;` and register `installer::install_docker`,
  `installer::install_ollama` in `invoke_handler![...]` alongside the existing
  three commands.
- `desktop/src-tauri/capabilities/default.json`: no changes needed — installer
  commands run as plain Tauri commands (like `start_stack`/`stop_stack`
  already do), not through a permissioned plugin API.

## Part 4 — Splash UI (`desktop/src/index.html`, `desktop/src/main.js`)

Add one more button next to the existing `#retry`:

```html
<button class="retry" id="install"></button>
```

In `main.js`, `boot()`'s catch block branches on `err.kind`:

- `missing_docker` / `missing_ollama`: set `status` to "`Docker`/`Ollama` is
  required.", put the disclosure text in `#error` (what's about to happen —
  "PrepAI can install it for you. You'll be asked for your admin password."
  plus, for Linux Docker specifically, the get.docker.com mention), show
  `#install` labeled `Install Docker` / `Install Ollama`, wire its `onclick`
  to a new `runInstall(command)` helper.
- anything else: unchanged existing behavior (generic message + `#retry`).

`runInstall(command)` calls `invoke(command)`, reuses the same spinner/status
elements, and on success checks `outcome.ready`: if true, call `boot()` again
(retries `start_stack` transparently); if false, leave the "restart PrepAI"
message on screen instead of looping (matches the Linux Docker case above —
retrying in the same process would just fail again with a confusing
permission error). On failure, fall back to showing `#retry` with the error
text, same as today's generic path.

## Part 5 — Download page (`frontend/src/app/download/page.tsx`)

Add a new "After downloading" section (same card styling as the existing
`Platforms`/`Requirements` sections — `rounded-2xl border border-slate-800
bg-slate-900/60`) placed right after the `#platforms` grid, with an OS toggle
reusing the existing `os` state (defaults to the detected platform, matches
the "pick another platform" affordance already on the page):

- **Linux**: `chmod +x PrepAI_0.1.0_amd64.AppImage` → `./PrepAI_0.1.0_amd64.AppImage`;
  alternative for the `.deb`: `sudo dpkg -i PrepAI_0.1.0_amd64.deb`, then
  launch "PrepAI" from the app menu.
- **macOS**: open the dmg, drag PrepAI to Applications; then, since the build
  is unsigned — *first launch only*: right-click PrepAI in Applications →
  Open → confirm in the dialog (or `xattr -cr /Applications/PrepAI.app` in
  Terminal as an alternative). State plainly that this is because the build
  isn't Apple-notarized yet, not that anything is actually wrong with it.
- **Windows**: run `PrepAI_0.1.0_x64-setup.exe`; SmartScreen may warn
  "unrecognized app" — More info → Run anyway (also unsigned, same reasoning).

Mention in-app installer availability for Docker/Ollama here too, so the page
and the app tell a consistent story ("first launch checks for Docker
automatically and can install it for you").

## Part 6 — Frontend performance: the packaged app is running Next.js dev mode

`frontend/Dockerfile`'s only `CMD` is `npm run dev` (`next dev`), and both
`docker-compose.yml` (dev/root) and `docker-compose.local.yml` (the one the
desktop app drives — `supervisor.rs` hardcodes `-f docker-compose.local.yml`)
build that same Dockerfile. So the app you're running in the Tauri window is
Next dev mode: unminified bundles, no production code-splitting tuning, React
dev-mode overhead, and on-demand per-route compilation the first time each
page is visited (that's the "○ Compiling /dashboard... ✓ Compiled in 3.6s"
lines in the docker-compose logs from earlier in this session). That's the
actual cause of "slow across the board," not just the landing page — the
Spline robot (`frontend/src/components/ui/interactive-3d-robot.tsx`, used
only in `frontend/src/app/page.tsx`) is a real but page-local cost on top of
that: it's already lazy-loaded behind `React.lazy`/`Suspense`, but
`@splinetool/react-spline`'s runtime is a large WebGL engine and the scene
streams from Spline's CDN — and on this specific box, its render loop is
competing for the same GPU that vLLM is using for inference, which is likely
adding extra jank here specifically.

**Fix**: keep `docker-compose.yml` (root, developer path) exactly as-is —
dev mode + the `./frontend:/app` bind mount is what makes hot reload work
while actively developing, don't touch it. In `docker-compose.local.yml`
only, override the frontend service's command to build once and serve the
production build:

```yaml
frontend:
  ...
  command: sh -c "npm run build && npm run start"
```

Verified assumption: `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` are
Next.js public env vars, which get inlined at `next build` time, not
runtime — but since compose's `environment:` block sets them for the whole
container process, both the `build` and `start` sub-commands in that one
`sh -c` see them identically, so this isn't a gotcha here.

Trade-offs to flag, not hide:
- **Slower cold start, much faster afterward.** `npm run build` adds
  real time (typically 30–90s for a project this size) before port 3000
  opens, so `supervisor.rs`'s progress message during that wait should say
  something like "Building the app (first launch)…" instead of the generic
  "Waiting for the app…" — 1-line tweak. `STARTUP_TIMEOUT` (600s) already has
  plenty of headroom, no change needed there.
- **No more hot reload / live `git pull` pickup** in this mode — the
  download page currently promises "Updating later is just `git pull` — the
  running stack picks up code changes automatically," which stops being true
  once this container runs a static build. Since the command rebuilds on
  every container start, the accurate replacement is "`git pull`, then
  restart PrepAI" (or `docker compose -f docker-compose.local.yml restart
  frontend`) — I'll update that line on the download page in the same edit
  as Part 5, so it doesn't quietly become false.

Not touching the Spline component itself in this pass — it's already
code-split, and switching to a production build already shrinks/minifies
that same chunk, so the honest move is to re-measure after the compose
change lands before deciding whether it still needs its own fix (e.g.
viewport-gating it, which wouldn't even help much since it's above the fold
already). I'll call this out as a "re-check after" item rather than guess at
a fix for a third-party library's internals I haven't profiled.

## Verification

- `cd desktop/src-tauri && cargo build` — confirms the new module compiles
  and the `StartupError`/`InstallOutcome` serde shapes are valid, without
  needing a GUI session.
- `cd desktop && npm run tauri dev` on this Linux box: with the current
  `senior_design`/`prepai-local` Docker stacks stopped, temporarily
  `sudo docker compose -f docker-compose.local.yml -p prepai-local down` and,
  if reachable, rename/hide `docker` from `PATH` in a throwaway shell (or test
  against a spare VM/container) to exercise the "Docker missing → Install
  Docker → pkexec prompt → restart message" path end-to-end; then restart the
  app and confirm `start_stack` succeeds normally. Mac/Ollama path can't be
  verified from this Linux box — call that out to the user as untested-in-CI,
  recommend they smoke-test it on an actual Mac before relying on it.
- Manually load `/download` in the running frontend and check the new
  "After downloading" section renders correctly for all three OS toggle
  states.
- After the `docker-compose.local.yml` command change: `docker compose -f
  docker-compose.local.yml up -d --build frontend`, watch `docker compose -f
  docker-compose.local.yml logs -f frontend` for the build to finish, then
  time-compare loading `/` and `/download` against how they felt under
  today's dev-mode container. Confirm `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL`
  actually got inlined correctly (check a network request from the built app
  hits `localhost:8080`, not an empty/undefined base URL) since that's the
  one way this change could subtly break rather than just be slow.
