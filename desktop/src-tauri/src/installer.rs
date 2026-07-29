//! In-app installers for the stack's prerequisites (Docker everywhere,
//! Ollama on Apple Silicon). Same ground rules as supervisor.rs: no extra
//! crates — downloads and installs shell out to tools already on the target
//! OS (curl, hdiutil, ditto, osascript, pkexec). The user's click on the
//! splash screen's "Install …" button is the consent gesture; the actual
//! privilege escalation is always the OS's own dialog (pkexec / osascript
//! "with administrator privileges") — we never see or store a password.

use std::process::Command;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::supervisor::port_open;
use crate::tools;

#[derive(Serialize)]
pub struct InstallOutcome {
    /// true = the tool is usable from this process right now, so the frontend
    /// can immediately retry start_stack. false = installed, but a restart of
    /// the app is needed first (Linux: the new `docker` group membership only
    /// applies to processes started after it was granted).
    pub ready: bool,
    pub message: String,
}

/// Is the docker CLI present anywhere we know to look? Distinct from
/// docker_ready(): a GUI app's PATH omits /usr/local/bin, so "cannot spawn
/// docker" must never be reported as "Docker isn't installed".
pub fn docker_installed() -> bool {
    tools::exists("docker")
}

/// Docker is usable: CLI resolvable AND the daemon answers. Re-resolves the
/// binary on every call, so it picks up the CLI symlink Docker Desktop creates
/// during its own first-launch setup.
pub fn docker_ready() -> bool {
    match tools::command("docker") {
        Ok(mut cmd) => cmd
            .arg("info")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false),
        Err(_) => false,
    }
}

/// Ollama serves on 11434 when it's actually up; a TCP probe beats checking
/// for the binary since "installed but not running" fails the same way.
pub fn ollama_ready() -> bool {
    port_open("127.0.0.1", 11434)
}

fn run_ok(cmd: &mut Command, what: &str) -> Result<(), String> {
    let out = cmd
        .output()
        .map_err(|e| format!("{what}: failed to launch: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let tail: String = stderr.lines().rev().take(4).collect::<Vec<_>>().iter().rev()
            .cloned().collect::<Vec<_>>().join("\n");
        return Err(format!("{what} failed: {}", if tail.is_empty() { "(no error output)".into() } else { tail }));
    }
    Ok(())
}

fn wait_until(what: &str, timeout: Duration, mut probe: impl FnMut() -> bool) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if probe() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(1500));
    }
    Err(format!("timed out after {}s waiting for {what}", timeout.as_secs()))
}

#[tauri::command]
pub async fn install_docker() -> Result<InstallOutcome, String> {
    if docker_ready() {
        return Ok(InstallOutcome { ready: true, message: "Docker is already running.".into() });
    }
    if cfg!(target_os = "macos") {
        install_docker_macos()
    } else if cfg!(target_os = "linux") {
        install_docker_linux()
    } else {
        Err("Automatic Docker install isn't supported on this OS. \
             Install Docker Desktop from https://docs.docker.com/get-docker/ and relaunch FinalRound."
            .into())
    }
}

fn install_docker_macos() -> Result<InstallOutcome, String> {
    let app_present = std::path::Path::new("/Applications/Docker.app").is_dir();
    if !app_present {
        let url = if cfg!(target_arch = "aarch64") {
            "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
        } else {
            "https://desktop.docker.com/mac/main/amd64/Docker.dmg"
        };
        let dmg = std::env::temp_dir().join("FinalRound-Docker.dmg");
        let dmg_str = dmg.to_string_lossy().to_string();

        tools::download(url, &dmg)?;
        run_ok(
            &mut tools::command("hdiutil")?.args(["attach", "-nobrowse", "-quiet", &dmg_str]),
            "mounting the Docker installer",
        )?;
        // Copy + accept-license in a single elevated call so macOS shows one
        // password dialog, not two. Volume name is fixed by Docker's dmg.
        let elevated = "do shell script \"cp -R /Volumes/Docker/Docker.app /Applications/ && \
                        /Applications/Docker.app/Contents/MacOS/Docker --accept-license\" \
                        with administrator privileges";
        let install = run_ok(&mut tools::command("osascript")?.args(["-e", elevated]), "installing Docker Desktop");
        if let Ok(mut c) = tools::command("hdiutil") {
            let _ = c.args(["detach", "-quiet", "/Volumes/Docker"]).output();
        }
        let _ = std::fs::remove_file(&dmg);
        install?;
    }

    // First launch of Docker Desktop is slow (it installs its privileged
    // helper — that authorization dialog is Docker's own, not ours).
    run_ok(&mut tools::command("open")?.args(["-a", "Docker"]), "launching Docker Desktop")?;
    wait_until("Docker to start", Duration::from_secs(120), docker_ready)?;
    Ok(InstallOutcome { ready: true, message: "Docker is installed and running.".into() })
}

fn install_docker_linux() -> Result<InstallOutcome, String> {
    if !tools::exists("pkexec") {
        return Err("Couldn't request admin rights (pkexec is missing). \
                    Install Docker manually:  curl -fsSL https://get.docker.com | sh  \
                    then add yourself to the docker group:  sudo usermod -aG docker $USER"
            .into());
    }
    // get.docker.com is Docker's official convenience installer and handles
    // distro detection (apt/dnf/pacman/…) itself. logname resolves the login
    // user even though this shell runs as root under pkexec.
    run_ok(
        &mut tools::command("pkexec")?.args([
            "sh",
            "-c",
            "curl -fsSL https://get.docker.com | sh && \
             usermod -aG docker \"$(logname)\" && \
             systemctl enable --now docker",
        ]),
        "installing Docker",
    )?;
    // The daemon is up, but THIS process predates the new `docker` group
    // membership, so its docker calls would still be denied. A restart of the
    // app (fresh process, fresh groups) is the honest fix — don't fake it.
    Ok(InstallOutcome {
        ready: false,
        message: "Docker was installed and started. Restart FinalRound so your \
                  account's new Docker permissions take effect."
            .into(),
    })
}

#[tauri::command]
pub async fn install_ollama() -> Result<InstallOutcome, String> {
    if !cfg!(target_os = "macos") {
        // detect_engine.sh only ever picks Ollama on Apple Silicon.
        return Err("Automatic Ollama install is only supported on macOS. \
                    See https://ollama.com/download for your platform."
            .into());
    }
    if ollama_ready() {
        return Ok(InstallOutcome { ready: true, message: "Ollama is already running.".into() });
    }

    if !std::path::Path::new("/Applications/Ollama.app").is_dir() {
        let zip = std::env::temp_dir().join("FinalRound-Ollama.zip");
        let zip_str = zip.to_string_lossy().to_string();
        tools::download("https://ollama.com/download/Ollama-darwin.zip", &zip)?;
        // Plain unzip into /Applications — same as a manual drag-install, no
        // elevation needed on a personal Mac.
        let extract = run_ok(
            &mut tools::command("ditto")?.args(["-x", "-k", &zip_str, "/Applications"]),
            "extracting Ollama into /Applications",
        );
        let _ = std::fs::remove_file(&zip);
        extract?;
    }

    run_ok(&mut tools::command("open")?.args(["-a", "Ollama"]), "launching Ollama")?;
    wait_until("Ollama to start", Duration::from_secs(30), ollama_ready)?;
    Ok(InstallOutcome { ready: true, message: "Ollama is installed and running.".into() })
}
