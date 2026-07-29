//! Supervises the local FinalRound stack for the desktop app (Option A: orchestrate
//! Docker Compose). On launch the splash UI invokes `start_stack`, which:
//!   1. locates the repo (compose file + scripts),
//!   2. runs scripts/detect_engine.sh to pick the inference engine + env,
//!   3. `docker compose ... up -d` with the right profile,
//!   4. polls the backend /health and the frontend until both answer,
//!   5. streams "startup:progress" events to the UI, then returns the app URL.
//!
//! No extra crates: HTTP health checks are done with a tiny raw GET over
//! std::net::TcpStream so the binary stays dependency-light and cross-platform.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::tools;

const APP_URL: &str = "http://localhost:3000";
const BACKEND_HOST: &str = "127.0.0.1";
const BACKEND_PORT: u16 = 8080;
const FRONTEND_PORT: u16 = 3000;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(600); // model pull can be slow

#[derive(Clone, Serialize)]
struct Progress {
    pct: u8,
    message: String,
}

/// Typed startup failure so the splash UI can offer the right recovery:
/// "Install Docker" / "Install Ollama" buttons for the missing-prereq cases,
/// plain retry for everything else.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartupError {
    // `installed` lets the UI offer "Start Docker" instead of "Install Docker"
    // when the CLI is present but the daemon is down — the case that used to
    // sit on "Installing…" until it timed out.
    MissingDocker { message: String, installed: bool },
    MissingOllama { message: String },
    Other { message: String },
}

impl From<String> for StartupError {
    fn from(message: String) -> Self {
        StartupError::Other { message }
    }
}

fn emit(app: &AppHandle, pct: u8, message: &str) {
    let _ = app.emit(
        "startup:progress",
        Progress {
            pct,
            message: message.to_string(),
        },
    );
}

/// Locate the repo root (holds docker-compose.local.yml). Honors $PREPAI_HOME,
/// else walks up from the current dir, else up from the executable's dir.
fn find_repo() -> Result<PathBuf, String> {
    // FINALROUND_HOME is the documented override; PREPAI_HOME stays supported
    // so existing installs from the old branding keep working.
    for var in ["FINALROUND_HOME", "PREPAI_HOME"] {
        if let Ok(dir) = std::env::var(var) {
            let p = PathBuf::from(dir);
            if p.join("docker-compose.local.yml").is_file() {
                return Ok(p);
            }
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
        }
    }
    for root in roots {
        let mut cur: Option<&Path> = Some(root.as_path());
        while let Some(dir) = cur {
            if dir.join("docker-compose.local.yml").is_file() {
                return Ok(dir.to_path_buf());
            }
            cur = dir.parent();
        }
    }
    Err("Could not find docker-compose.local.yml. Set FINALROUND_HOME to the repo.".into())
}

/// Source tarball of the default branch — what an installed app runs against
/// when there is no local checkout. Kept as a tarball download (curl + tar,
/// both present on Linux, macOS, and Windows 10+) so end users don't need git.
const REPO_TARBALL: &str =
    "https://github.com/vkr-vavilla/Senior_Design/archive/refs/heads/main.tar.gz";

fn home_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .map_err(|_| "Could not determine your home directory.".into())
}

/// End-user path: the installed app has no repo next to it, so fetch the
/// source tree into ~/.prepai on first launch. Idempotent — if a previous
/// download is already there, reuse it.
fn bootstrap_repo(app: &AppHandle) -> Result<PathBuf, String> {
    let home = home_dir()?;
    let base = home.join(".finalround");
    let repo = base.join("Senior_Design-main");
    if repo.join("docker-compose.local.yml").is_file() {
        return Ok(repo);
    }
    // Reuse a runtime downloaded under the old ~/.prepai name rather than
    // making existing users re-download ~13 MB and regenerate their .env.
    let legacy = home.join(".prepai").join("Senior_Design-main");
    if legacy.join("docker-compose.local.yml").is_file() {
        return Ok(legacy);
    }
    std::fs::create_dir_all(&base).map_err(|e| format!("could not create {}: {e}", base.display()))?;

    emit(app, 8, "First launch: downloading the FinalRound runtime…");
    let tarball = base.join("finalround-src.tar.gz");
    let tarball_str = tarball.to_string_lossy().to_string();
    tools::download(REPO_TARBALL, &tarball)?;

    emit(app, 12, "Unpacking the FinalRound runtime…");
    let base_str = base.to_string_lossy().to_string();
    let out = tools::command("tar")?
        .args(["-xzf", &tarball_str, "-C", &base_str])
        .output()
        .map_err(|e| format!("failed to run tar: {e}"))?;
    let _ = std::fs::remove_file(&tarball);
    if !out.status.success() {
        return Err(format!(
            "Could not unpack the FinalRound runtime: {}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        ));
    }
    if !repo.join("docker-compose.local.yml").is_file() {
        return Err("Downloaded runtime is missing docker-compose.local.yml.".into());
    }
    Ok(repo)
}

/// First-run twin of setup_local.sh's env generation: compose hard-fails on a
/// missing backend/.env (env_file directive), and installed-app users never
/// run the setup script. Same keys, fresh random JWT secret. Never overwrites.
fn ensure_backend_env(repo: &Path) -> Result<(), String> {
    let env_file = repo.join("backend").join(".env");
    if env_file.is_file() {
        return Ok(());
    }
    let mut buf = [0u8; 64];
    let unix_random = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_ok();
    if !unix_random {
        // Windows: no /dev/urandom, and no RNG in std — but every
        // RandomState is seeded from OS entropy, so hash our way to 64 bytes.
        use std::hash::{BuildHasher, Hasher};
        for chunk in buf.chunks_mut(8) {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u64(std::process::id() as u64);
            chunk.copy_from_slice(&h.finish().to_le_bytes()[..chunk.len()]);
        }
    }
    let secret: String = buf.iter().map(|b| format!("{b:02x}")).collect();
    let contents = format!(
        "# Generated by the FinalRound desktop app — per-machine settings, never commit this file.\n\
         DB_NAME=FinalRound\n\
         JWT_SECRET={secret}\n\n\
         # Only used in Gemini API mode (no GPU). Get a free key: https://aistudio.google.com\n\
         GEMINI_API_KEY=\n"
    );
    std::fs::write(&env_file, contents)
        .map_err(|e| format!("could not write {}: {e}", env_file.display()))
}

/// Run scripts/detect_engine.sh and parse its KEY=value env block.
fn detect_engine(repo: &Path) -> Result<HashMap<String, String>, String> {
    let script = repo.join("scripts/detect_engine.sh");
    if !script.is_file() {
        return Err(format!("detect_engine.sh not found at {}", script.display()));
    }
    // Point vLLM detection at the compose service name (URL on the compose
    // network). Ollama is deliberately left alone: it runs natively on the host
    // for Metal access, so detect_engine.sh resolves it via host.docker.internal.
    let out = tools::command("bash")?
        .arg(&script)
        .current_dir(repo)
        .env("PREPAI_VLLM_URL", "http://vllm:8001/v1")
        .output()
        .map_err(|e| format!("failed to run detect_engine.sh: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "detect_engine.sh failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let mut env = HashMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if let Some((k, v)) = line.split_once('=') {
            env.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    if !env.contains_key("INFERENCE_ENGINE") {
        return Err("detect_engine.sh produced no INFERENCE_ENGINE".into());
    }
    Ok(env)
}

/// `docker compose -f docker-compose.local.yml [--profile P] up -d`, with the
/// engine env from detect_engine injected so compose interpolates it.
fn compose_up(repo: &Path, env: &HashMap<String, String>) -> Result<(), String> {
    let mut cmd = tools::command("docker")?;
    cmd.current_dir(repo)
        .arg("compose")
        .arg("-f")
        .arg("docker-compose.local.yml");
    if let Some(profile) = env.get("COMPOSE_PROFILES") {
        if !profile.is_empty() {
            cmd.arg("--profile").arg(profile);
        }
    }
    cmd.arg("up").arg("-d");
    // Forward the engine-selection vars compose reads.
    for key in [
        "AI_BACKEND",
        "VLLM_BASE_URL",
        "VLLM_MODEL",
        "VLLM_BASE_MODEL",
    ] {
        if let Some(v) = env.get(key) {
            cmd.env(key, v);
        }
    }
    let status = cmd
        .status()
        .map_err(|e| format!("failed to run docker compose: {e}. Is Docker installed and running?"))?;
    if !status.success() {
        return Err("docker compose up failed — check Docker Desktop is running.".into());
    }
    Ok(())
}

/// Minimal HTTP GET; true when the server answers `200`.
fn http_ok(host: &str, port: u16, path: &str) -> bool {
    let addr = format!("{host}:{port}");
    let Ok(mut stream) = TcpStream::connect_timeout(
        &match addr.parse() {
            Ok(a) => a,
            Err(_) => return false,
        },
        Duration::from_secs(2),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET {path} HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = stream.read_to_end(&mut buf);
    let head = String::from_utf8_lossy(&buf);
    head.starts_with("HTTP/1.") && head.split_whitespace().nth(1) == Some("200")
}

/// TCP port open (frontend dev server is up before it serves a 200).
pub(crate) fn port_open(host: &str, port: u16) -> bool {
    format!("{host}:{port}")
        .parse()
        .ok()
        .and_then(|a| TcpStream::connect_timeout(&a, Duration::from_secs(2)).ok())
        .is_some()
}

/// Bring the whole stack up; returns the URL to load when ready.
#[tauri::command]
pub async fn start_stack(app: AppHandle) -> Result<String, StartupError> {
    emit(&app, 5, "Locating FinalRound…");
    // Developer checkout first; otherwise this is an installed app — fetch the
    // runtime into ~/.prepai on first launch instead of erroring out.
    let repo = match find_repo() {
        Ok(repo) => repo,
        Err(_) => bootstrap_repo(&app)?,
    };
    ensure_backend_env(&repo)?;

    emit(&app, 15, "Detecting hardware and inference engine…");
    let env = detect_engine(&repo)?;
    let engine = env.get("INFERENCE_ENGINE").cloned().unwrap_or_default();

    emit(&app, 20, "Checking prerequisites…");
    if !crate::installer::docker_ready() {
        let installed = crate::installer::docker_installed();
        let message = if installed {
            "Docker is installed but not running.".to_string()
        } else {
            "Docker isn't installed.".to_string()
        };
        return Err(StartupError::MissingDocker { message, installed });
    }
    if engine == "ollama" && !crate::installer::ollama_ready() {
        return Err(StartupError::MissingOllama {
            message: "Ollama isn't installed or isn't running.".into(),
        });
    }

    emit(&app, 30, &format!("Starting services (engine: {engine})…"));
    compose_up(&repo, &env)?;

    emit(&app, 45, "Waiting for the backend…");
    let start = Instant::now();
    let mut backend_ready = false;
    let mut frontend_ready = false;
    while start.elapsed() < STARTUP_TIMEOUT {
        if !backend_ready && http_ok(BACKEND_HOST, BACKEND_PORT, "/health") {
            backend_ready = true;
            // The frontend container compiles a production build before it
            // serves anything, so this leg of the wait is the long one.
            emit(&app, 70, "Backend ready. Building the app (takes a minute on first launch)…");
        }
        // A real 200, not just an open port: Docker publishes the port the
        // moment the container starts, long before `next build` finishes and
        // the server inside actually listens — navigating then shows the user
        // a "connection reset" page.
        if backend_ready && !frontend_ready && http_ok(BACKEND_HOST, FRONTEND_PORT, "/") {
            frontend_ready = true;
        }
        if backend_ready && frontend_ready {
            emit(&app, 100, "Ready.");
            return Ok(APP_URL.to_string());
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
    Err(StartupError::Other {
        message: format!(
            "Timed out after {}s waiting for the stack (engine: {engine}).",
            STARTUP_TIMEOUT.as_secs()
        ),
    })
}

/// Where an installed app keeps its runtime (new name first, legacy second).
fn bootstrap_dir() -> Result<PathBuf, String> {
    let home = home_dir()?;
    let new = home.join(".finalround").join("Senior_Design-main");
    if new.join("docker-compose.local.yml").is_file() {
        return Ok(new);
    }
    Ok(home.join(".prepai").join("Senior_Design-main"))
}

/// Best-effort shutdown of the stack (leaves volumes intact).
#[tauri::command]
pub async fn stop_stack() -> Result<(), String> {
    let repo = match find_repo() {
        Ok(repo) => repo,
        // Installed app: the runtime lives in ~/.prepai (see bootstrap_repo).
        Err(_) => bootstrap_dir()?,
    };
    if let Ok(mut cmd) = tools::command("docker") {
        let _ = cmd
            .current_dir(&repo)
            .args(["compose", "-f", "docker-compose.local.yml", "stop"])
            .status();
    }
    Ok(())
}

/// The URL the webview should load once the stack is up.
#[tauri::command]
pub fn app_url() -> String {
    APP_URL.to_string()
}
