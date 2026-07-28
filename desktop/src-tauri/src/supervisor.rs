//! Supervises the local PrepAI stack for the desktop app (Option A: orchestrate
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
use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

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
    MissingDocker { message: String },
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
    if let Ok(dir) = std::env::var("PREPAI_HOME") {
        let p = PathBuf::from(dir);
        if p.join("docker-compose.local.yml").is_file() {
            return Ok(p);
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
    Err("Could not find docker-compose.local.yml. Set PREPAI_HOME to the repo.".into())
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
    let out = Command::new("bash")
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
    let mut cmd = Command::new("docker");
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
    emit(&app, 5, "Locating PrepAI…");
    let repo = find_repo()?;

    emit(&app, 15, "Detecting hardware and inference engine…");
    let env = detect_engine(&repo)?;
    let engine = env.get("INFERENCE_ENGINE").cloned().unwrap_or_default();

    emit(&app, 20, "Checking prerequisites…");
    if !crate::installer::docker_ready() {
        return Err(StartupError::MissingDocker {
            message: "Docker isn't installed or isn't running.".into(),
        });
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
        if backend_ready && !frontend_ready && port_open(BACKEND_HOST, FRONTEND_PORT) {
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

/// Best-effort shutdown of the stack (leaves volumes intact).
#[tauri::command]
pub async fn stop_stack() -> Result<(), String> {
    let repo = find_repo()?;
    let _ = Command::new("docker")
        .current_dir(&repo)
        .args(["compose", "-f", "docker-compose.local.yml", "stop"])
        .status();
    Ok(())
}

/// The URL the webview should load once the stack is up.
#[tauri::command]
pub fn app_url() -> String {
    APP_URL.to_string()
}
