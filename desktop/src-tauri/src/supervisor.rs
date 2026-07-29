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
    // `action` tells the UI which recovery to offer: "install" (no Docker),
    // "start" (present but daemon down) or "relogin" (present and running, but
    // this account has no access and `sg` can't bridge it). Without this the UI
    // offered a button that re-ran the same setup and bounced the user between
    // "installed but not running" and "restart the app" forever.
    MissingDocker { message: String, action: String },
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
    // making existing users re-download and regenerate their .env.
    let legacy = home.join(".prepai").join("Senior_Design-main");
    if legacy.join("docker-compose.local.yml").is_file() {
        return Ok(legacy);
    }

    // The installer ships the runtime as a bundled resource, so a fresh machine
    // needs no network and no curl/wget (both absent on a stock ubuntu:24.04).
    // Downloading is only the fallback when the resource is missing.
    if let Some(extracted) = extract_bundled_runtime(app, &base) {
        return Ok(extracted);
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

/// Extract the runtime tarball bundled with the installer into `base`.
/// Returns None when there is no bundled copy, or extraction failed — callers
/// then fall back to downloading.
fn extract_bundled_runtime(app: &AppHandle, base: &Path) -> Option<PathBuf> {
    use tauri::Manager;
    let bundled = app.path().resource_dir().ok()?.join("runtime.tar.gz");
    if !bundled.is_file() {
        return None;
    }
    emit(app, 10, "Unpacking the FinalRound runtime…");
    std::fs::create_dir_all(base).ok()?;
    let out = tools::command("tar")
        .ok()?
        .args([
            "-xzf",
            &bundled.to_string_lossy(),
            "-C",
            &base.to_string_lossy(),
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let repo = base.join("Senior_Design-main");
    repo.join("docker-compose.local.yml").is_file().then_some(repo)
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
fn detect_engine(repo: &Path, docker_gpu: bool) -> Result<HashMap<String, String>, String> {
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
        .env("PREPAI_DOCKER_GPU", if docker_gpu { "1" } else { "0" })
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
    // Never assume `docker compose` exists — see installer::compose_prefix.
    let compose = crate::installer::compose_prefix()
        .ok_or_else(|| "Docker Compose isn't available.".to_string())?;

    let mut cmdline = format!(
        "{compose} -f {}",
        tools::shell_quote("docker-compose.local.yml")
    );
    if let Some(profile) = env.get("COMPOSE_PROFILES") {
        if !profile.is_empty() {
            cmdline.push_str(&format!(" --profile {}", tools::shell_quote(profile)));
        }
    }
    cmdline.push_str(" up -d");

    let mut cmd = match crate::installer::docker_access() {
        crate::installer::DockerAccess::ViaGroup => tools::sg_command("docker", &cmdline)?,
        _ => tools::sh_command(&cmdline)?,
    };
    cmd.current_dir(repo);
    for key in ["AI_BACKEND", "VLLM_BASE_URL", "VLLM_MODEL", "VLLM_BASE_MODEL"] {
        if let Some(v) = env.get(key) {
            cmd.env(key, v);
        }
    }
    let out = cmd
        .output()
        .map_err(|e| format!("failed to run docker compose: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "docker compose up failed.\n{}",
            stderr.lines().rev().take(4).collect::<Vec<_>>().join("\n")
        ));
    }
    Ok(())
}

/// Free space in GiB on the filesystem holding `path`, via POSIX `df`.
/// std has no portable statvfs and we take no extra crates.
fn free_gib(path: &Path) -> Option<u64> {
    let out = tools::command("df")
        .ok()?
        .args(["-Pk", &path.to_string_lossy()])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let avail_kb: u64 = text.lines().nth(1)?.split_whitespace().nth(3)?.parse().ok()?;
    Some(avail_kb / 1024 / 1024)
}

/// Images plus the ~5.5 GB of model weights need real room; running out mid-pull
/// surfaces as a confusing compose/vLLM error deep into a long first launch.
const MIN_FREE_GIB: u64 = 12;

/// Register the Ollama models the backend will ask for (Apple Silicon path).
///
/// `ollama_ready()` only proves the daemon answers on 11434 — a freshly
/// installed Ollama has no models at all, so without this the backend requests
/// model "interviewer" and every turn fails. setup_local.sh does this for
/// from-source users; installed-app users never run it. Mirrors that logic:
/// fetch the published adapter, then `ollama create` both tags.
fn ensure_ollama_models(app: &AppHandle, repo: &Path, env: &HashMap<String, String>) -> Result<(), String> {
    let interviewer = env.get("VLLM_MODEL").cloned().unwrap_or_else(|| "interviewer".into());
    let base = env
        .get("VLLM_BASE_MODEL")
        .cloned()
        .unwrap_or_else(|| "qwen2.5-7b-instruct".into());

    let listed = tools::command("ollama")?
        .arg("list")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default();
    let registered = |tag: &str| listed.lines().any(|l| l.split_whitespace().next() == Some(tag));
    if registered(&interviewer) && registered(&base) {
        return Ok(());
    }

    // The adapter is ours and must be fetched; the base is a public Ollama tag
    // that `ollama create` pulls on demand.
    let adapter = repo.join("ollama").join("models").join("interviewer-lora.gguf");
    if !adapter.is_file() {
        emit(app, 34, "Downloading the interviewer model (one-time, ~323 MB)…");
        std::fs::create_dir_all(adapter.parent().unwrap())
            .map_err(|e| format!("could not create ollama/models: {e}"))?;
        tools::download(
            "https://huggingface.co/FinalRound/prepai-interviewer/resolve/main/interviewer-lora.gguf",
            &adapter,
        )?;
    }

    for (tag, modelfile) in [(&base, "Modelfile.base"), (&interviewer, "Modelfile.interviewer")] {
        if registered(tag) {
            continue;
        }
        emit(app, 38, &format!("Registering local model '{tag}'…"));
        let src = repo.join("ollama").join(modelfile);
        let text = std::fs::read_to_string(&src)
            .map_err(|e| format!("could not read {}: {e}", src.display()))?;
        // Absolutise the relative ADAPTER path so `ollama create` resolves it
        // no matter what directory it runs from.
        let abs_models = repo.join("ollama").join("models");
        let patched = text.replace(
            "ADAPTER ./models/",
            &format!("ADAPTER {}/", abs_models.to_string_lossy()),
        );
        let tmp = std::env::temp_dir().join(format!("finalround-{modelfile}"));
        std::fs::write(&tmp, patched).map_err(|e| format!("could not stage {modelfile}: {e}"))?;

        let out = tools::command("ollama")?
            .args(["create", tag, "-f", &tmp.to_string_lossy()])
            .output()
            .map_err(|e| format!("failed to run ollama create: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        if !out.status.success() {
            return Err(format!(
                "Couldn't register the local model '{tag}':\n{}",
                String::from_utf8_lossy(&out.stderr)
                    .lines()
                    .rev()
                    .take(3)
                    .collect::<Vec<_>>()
                    .join("\n")
            ));
        }
    }
    Ok(())
}

/// Seed the coding-problem bank once. setup_local.sh does this for from-source
/// users; installed-app users never run it, so their coding round would have no
/// problems at all. Best-effort: a failure here must not block the interview.
fn seed_problem_bank(app: &AppHandle, repo: &Path) {
    let Some(compose) = crate::installer::compose_prefix() else { return };
    let run = |cmdline: &str| -> Option<std::process::Output> {
        let built = match crate::installer::docker_access() {
            crate::installer::DockerAccess::ViaGroup => tools::sg_command("docker", cmdline),
            _ => tools::sh_command(cmdline),
        };
        built.ok()?.current_dir(repo).output().ok()
    };

    let count_py = "import os,pymongo;c=pymongo.MongoClient(os.environ['MONGODB_URI']);\
print(c[os.environ.get('DB_NAME','FinalRound')][os.environ.get('PROBLEMS_COLLECTION','leetcode')].count_documents({}))";
    let count_cmd = format!(
        "{compose} -f {} exec -T backend python -c {}",
        tools::shell_quote("docker-compose.local.yml"),
        tools::shell_quote(count_py)
    );
    let existing: u64 = run(&count_cmd)
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().parse().unwrap_or(0))
        .unwrap_or(0);
    if existing > 0 {
        return;
    }

    emit(app, 90, "Preparing coding problems (one-time, a few minutes)…");
    let seed_cmd = format!(
        "{compose} -f {} exec -T backend python -m scripts.scrape_leetcode --per-difficulty 25 --sleep 1.0",
        tools::shell_quote("docker-compose.local.yml")
    );
    let _ = run(&seed_cmd);
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

    emit(&app, 18, "Checking prerequisites…");
    use crate::installer::DockerAccess;
    let access = crate::installer::docker_access();
    if !matches!(access, DockerAccess::Ready | DockerAccess::ViaGroup) {
        let (message, action) = match access {
            DockerAccess::NotInstalled => ("Docker isn't installed.", "install"),
            DockerAccess::DaemonDown => ("Docker is installed but not running.", "start"),
            // Running, but this account can't reach the socket and `sg` can't
            // stand in — a real re-login (or the group fix) is required.
            _ => (
                "Docker is running, but your account doesn't have permission to use it.",
                "relogin",
            ),
        };
        return Err(StartupError::MissingDocker {
            message: message.to_string(),
            action: action.to_string(),
        });
    }

    // Compose is a separate package from the engine and is genuinely absent on
    // some installs; the same elevated setup installs it, so reuse that button.
    if crate::installer::compose_prefix().is_none() {
        return Err(StartupError::MissingDocker {
            message: "Docker is installed, but Docker Compose is missing.".into(),
            action: "install".into(),
        });
    }

    // Bail out early rather than failing deep inside a multi-GB pull.
    if let Some(free) = free_gib(&repo) {
        if free < MIN_FREE_GIB {
            return Err(StartupError::Other {
                message: format!(
                    "Not enough free disk space: {free} GiB available, about {MIN_FREE_GIB} GiB \
                     needed for the container images and model weights. Free some space and \
                     reopen FinalRound."
                ),
            });
        }
    }

    emit(&app, 22, "Detecting hardware and inference engine…");
    // A host NVIDIA driver isn't enough for the gpu profile — tell the detector
    // whether Docker can actually pass a GPU through, so it falls back to the
    // cloud engine instead of compose dying on a missing device driver.
    let env = detect_engine(&repo, crate::installer::docker_has_gpu())?;
    let engine = env.get("INFERENCE_ENGINE").cloned().unwrap_or_default();

    if engine == "ollama" {
        if !crate::installer::ollama_ready() {
            return Err(StartupError::MissingOllama {
                message: "Ollama isn't installed or isn't running.".into(),
            });
        }
        // Daemon up is not the same as models present.
        ensure_ollama_models(&app, &repo, &env)?;
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
            seed_problem_bank(&app, &repo);
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
    if let Some(docker) = tools::find("docker") {
        let cmdline = format!(
            "{} compose -f {} stop",
            tools::shell_quote(&docker.to_string_lossy()),
            tools::shell_quote("docker-compose.local.yml")
        );
        let built = match crate::installer::docker_access() {
            crate::installer::DockerAccess::ViaGroup => tools::sg_command("docker", &cmdline),
            _ => tools::sh_command(&cmdline),
        };
        if let Ok(mut cmd) = built {
            let _ = cmd.current_dir(&repo).status();
        }
    }
    Ok(())
}

/// The URL the webview should load once the stack is up.
#[tauri::command]
pub fn app_url() -> String {
    APP_URL.to_string()
}
