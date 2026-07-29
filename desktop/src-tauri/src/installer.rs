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

/// How (or whether) this process can talk to Docker. Distinguishing these is
/// what stops the app looping: "daemon down" and "your session lacks the docker
/// group" look identical through a bare `docker info` exit code, but they need
/// completely different fixes.
#[derive(Clone, Copy, PartialEq)]
pub enum DockerAccess {
    /// Direct invocation works.
    Ready,
    /// Denied directly, but works through `sg docker` — i.e. the account is in
    /// the docker group and only this login session hasn't picked it up yet.
    ViaGroup,
    /// Installed, reachable, but the daemon isn't running.
    DaemonDown,
    /// Installed and running, but this account has no access and `sg` can't
    /// bridge it (not in the group yet, or `sg` unavailable).
    NoPermission,
    NotInstalled,
}

/// The docker CLI resolved absolutely, as a shell-quoted program name.
fn docker_bin() -> Option<String> {
    tools::find("docker").map(|p| tools::shell_quote(&p.to_string_lossy()))
}

pub fn docker_access() -> DockerAccess {
    let Some(docker) = docker_bin() else {
        return DockerAccess::NotInstalled;
    };
    let probe = format!("{docker} info");

    let direct = tools::sh_command(&probe).and_then(|mut c| {
        c.output().map_err(|e| e.to_string())
    });
    let Ok(out) = direct else {
        return DockerAccess::NotInstalled;
    };
    if out.status.success() {
        return DockerAccess::Ready;
    }

    let stderr = String::from_utf8_lossy(&out.stderr).to_lowercase();
    let denied = stderr.contains("permission denied");
    if denied {
        // Try the group bridge before telling anyone to log out.
        if let Ok(mut c) = tools::sg_command("docker", &probe) {
            if c.output().map(|o| o.status.success()).unwrap_or(false) {
                return DockerAccess::ViaGroup;
            }
        }
        return DockerAccess::NoPermission;
    }
    DockerAccess::DaemonDown
}


/// Docker is usable right now, by whatever route.
pub fn docker_ready() -> bool {
    matches!(docker_access(), DockerAccess::Ready | DockerAccess::ViaGroup)
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

/// Elevated first-run setup, run once under pkexec. Written defensively because
/// this executes on machines we've never seen:
///   * the `docker` group may not exist yet (usermod fails hard on a missing
///     group — the error a fresh Ubuntu box hit),
///   * `logname` needs a controlling terminal, which a GUI-launched app has
///     none of, so it returns nothing; pkexec exports PKEXEC_UID instead,
///   * not every distro is systemd,
///   * curl is not guaranteed to be installed.
/// Steps are independent and each failure names itself on stderr, so the UI can
/// show which one broke instead of one opaque "installing Docker failed".
const LINUX_DOCKER_SETUP: &str = r#"
set -u
fail() { echo "STEP_FAILED: $1" >&2; exit "$2"; }

# 1. Install Docker unless it is already present.
if ! command -v docker >/dev/null 2>&1; then
  # Docker's installer aborts if the package index is stale or half-broken,
  # which is the default state of a freshly imaged machine. Refresh first and
  # keep going even if some third-party repo is unreachable.
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq || apt-get update -qq --allow-releaseinfo-change || true
  elif command -v dnf >/dev/null 2>&1; then
    dnf -y makecache || true
  fi
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com -o /tmp/get-docker.sh || fail download 11
  elif command -v wget >/dev/null 2>&1; then
    wget -qO /tmp/get-docker.sh https://get.docker.com || fail download 11
  else
    fail no-downloader 12
  fi
  sh /tmp/get-docker.sh || fail installer 13
  rm -f /tmp/get-docker.sh
fi
command -v docker >/dev/null 2>&1 || fail docker-missing 14

# 2. Ensure the docker group exists before touching membership. -f makes this a
#    no-op when it is already there.
groupadd -f docker 2>/dev/null || true
getent group docker >/dev/null 2>&1 || fail groupadd 15

# 3. Work out which human launched us. PKEXEC_UID is the reliable source under
#    a GUI launch; the rest are fallbacks for other elevation paths.
TARGET=""
if [ -n "${PKEXEC_UID:-}" ]; then TARGET="$(id -nu "$PKEXEC_UID" 2>/dev/null || true)"; fi
[ -n "$TARGET" ] || TARGET="${SUDO_USER:-}"
[ -n "$TARGET" ] || TARGET="$(logname 2>/dev/null || true)"
[ -n "$TARGET" ] || fail no-user 16
usermod -aG docker "$TARGET" || fail usermod 17

# 4. Start the daemon. Skipped, not fatal, on non-systemd systems.
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker || true
elif command -v service >/dev/null 2>&1; then
  service docker start || true
fi
echo "OK $TARGET"
"#;

fn install_docker_linux() -> Result<InstallOutcome, String> {
    if !tools::exists("pkexec") {
        return Err("Couldn't request admin rights (pkexec is missing). \
                    Install Docker manually:  curl -fsSL https://get.docker.com | sh  \
                    then add yourself to the docker group:  sudo usermod -aG docker $USER"
            .into());
    }
    let out = tools::command("pkexec")?
        .args(["sh", "-c", LINUX_DOCKER_SETUP])
        .output()
        .map_err(|e| format!("failed to request admin rights: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let step = stderr
            .lines()
            .rev()
            .find_map(|l| l.strip_prefix("STEP_FAILED: "))
            .unwrap_or("");
        return Err(match step {
            "download" | "no-downloader" => "Couldn't download Docker's installer. \
                Check your internet connection, or install Docker yourself from \
                https://docs.docker.com/engine/install/ and reopen FinalRound."
                .to_string(),
            "installer" | "docker-missing" => format!(
                "Docker's own installer didn't complete on this system. Install Docker \
                 from https://docs.docker.com/engine/install/ and reopen FinalRound.\n{}",
                stderr.lines().rev().take(3).collect::<Vec<_>>().join(" ")
            ),
            "groupadd" | "usermod" | "no-user" => "Docker installed, but adding your \
                account to the 'docker' group failed. Run this once, then log out and \
                back in:  sudo groupadd -f docker && sudo usermod -aG docker $USER"
                .to_string(),
            // Empty step means pkexec itself failed — most often the user
            // dismissed the password prompt.
            _ => "Admin permission was denied, so Docker wasn't installed.".to_string(),
        });
    }

    // This session's processes still carry the group list they were given at
    // login, so a direct `docker` call is still denied — but `sg docker` reads
    // /etc/group at exec time, so the membership we just granted is usable
    // immediately. If that works, carry on without making anyone log out.
    match docker_access() {
        DockerAccess::Ready | DockerAccess::ViaGroup => Ok(InstallOutcome {
            ready: true,
            message: "Docker is installed and running.".into(),
        }),
        DockerAccess::DaemonDown => Ok(InstallOutcome {
            ready: false,
            message: "Docker was installed but its service didn't start. Start Docker \
                      (or reboot), then reopen FinalRound."
                .into(),
        }),
        _ => Ok(InstallOutcome {
            ready: false,
            message: "Docker is installed, but your account still can't reach it. \
                      Log out and back in (or reboot), then reopen FinalRound."
                .into(),
        }),
    }
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
