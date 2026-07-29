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

/// Run a shell line through whichever docker route works here.
fn docker_sh(cmdline: &str) -> Result<std::process::Output, String> {
    let built = if docker_access() == DockerAccess::ViaGroup {
        tools::sg_command("docker", cmdline)
    } else {
        tools::sh_command(cmdline)
    };
    built?.output().map_err(|e| e.to_string())
}

/// The shell-quoted command prefix that runs Compose here, or None when Compose
/// isn't usable at all.
///
/// `docker compose` (the v2 CLI plugin) is NOT guaranteed to exist: a machine
/// where Docker came from `apt install docker.io` has the engine and no plugin,
/// and `docker compose …` then fails with "docker: unknown command" plus a dump
/// of Docker's usage text. Try the plugin, then a standalone `docker-compose`.
pub fn compose_prefix() -> Option<String> {
    let docker = docker_bin()?;
    let plugin = format!("{docker} compose");
    if docker_sh(&format!("{plugin} version"))
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some(plugin);
    }
    let standalone = tools::shell_quote(&tools::find("docker-compose")?.to_string_lossy());
    if docker_sh(&format!("{standalone} version"))
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return Some(standalone);
    }
    None
}

/// Can Docker actually hand a GPU to a container? A host NVIDIA driver is not
/// enough — that needs the NVIDIA Container Toolkit, without which the compose
/// `gpu` profile dies with 'could not select device driver "nvidia"'.
pub fn docker_has_gpu() -> bool {
    let Some(docker) = docker_bin() else { return false };
    docker_sh(&format!("{docker} info --format '{{{{json .Runtimes}}}}'"))
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("nvidia"))
        .unwrap_or(false)
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
    // Both halves must be present, not just the engine. Checking only
    // docker_ready() here meant a machine with Docker running but no Compose
    // plugin short-circuited to "already running" — so the setup that installs
    // Compose never ran, and the UI bounced between "Compose is missing" and a
    // button that did nothing.
    if docker_ready() && compose_prefix().is_some() {
        return Ok(InstallOutcome {
            ready: true,
            message: "Docker and Compose are ready.".into(),
        });
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
        // Copy only. Two earlier problems with doing more here: the documented
        // license flag lives on .../MacOS/install, not .../MacOS/Docker, so the
        // old call could fail outright; and running Docker itself as root leaves
        // root-owned files in ~/.docker that break the user's later invocations.
        // Docker Desktop presents its own license/privileges flow on first
        // launch, which is what `open -a Docker` below triggers.
        let elevated = "do shell script \"cp -R /Volumes/Docker/Docker.app /Applications/\" \
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

/// Elevated first-run setup, run once under pkexec. Everything here is written
/// for a machine with nothing on it, because that is what end users have:
///   * neither curl nor wget may exist (both absent on a stock ubuntu:24.04),
///   * the package index is usually stale, which aborts Docker's installer,
///   * the `docker` group may not exist — usermod fails hard if it doesn't,
///   * `logname` needs a controlling terminal a GUI app doesn't have; pkexec
///     exports PKEXEC_UID instead,
///   * `apt install docker.io` gives an engine with NO compose v2 plugin, so
///     `docker compose` is an unknown command,
///   * an NVIDIA driver on the host does not mean Docker can pass the GPU
///     through — that needs the NVIDIA Container Toolkit,
///   * not every distro is systemd.
/// Each step names itself on stderr so the UI can say which one broke.
const LINUX_DOCKER_SETUP: &str = r#"
set -u
fail() { echo "STEP_FAILED: $1" >&2; exit "$2"; }
have() { command -v "$1" >/dev/null 2>&1; }

PKG=""
if have apt-get; then PKG=apt; elif have dnf; then PKG=dnf; elif have pacman; then PKG=pacman; fi

# 0a. A half-configured package blocks EVERY later apt operation, so nothing
#     below can succeed until it is cleared. The usual cause is a driver package
#     whose kernel-module build failed (e.g. nvidia-dkms-*). Completing pending
#     configuration is safe and often enough; if it isn't, stop and say so
#     rather than emitting a confusing failure from an unrelated step.
if [ "$PKG" = apt ]; then
  dpkg --configure -a >/dev/null 2>&1 || true
  AUDIT="$(dpkg --audit 2>/dev/null | grep -E '^ [a-z0-9]' | awk '{print $1}' | tr '\n' ' ')"
  if [ -n "${AUDIT# }" ]; then
    echo "BROKEN_PKGS: $AUDIT" >&2
    fail dpkg-broken 19
  fi
fi

# 0b. Refresh the package index. A freshly imaged machine's index is stale or
#     half-broken, which is enough to abort Docker's installer.
case "$PKG" in
  apt) apt-get update -qq || apt-get update -qq --allow-releaseinfo-change || true ;;
  dnf) dnf -y makecache || true ;;
  pacman) pacman -Sy --noconfirm || true ;;
esac

# 1. Guarantee the basics every later step assumes. A stock ubuntu:24.04 has
#    NONE of these: no curl, no wget, no gnupg, and no CA bundle — without which
#    every HTTPS fetch dies with "error setting certificate file" and the NVIDIA
#    repo key can't be dearmored.
NEED=""
have curl || have wget || NEED="$NEED curl"
[ -s /etc/ssl/certs/ca-certificates.crt ] || NEED="$NEED ca-certificates"
have gpg || NEED="$NEED gnupg"
if [ -n "$NEED" ]; then
  case "$PKG" in
    apt) apt-get install -y $NEED >/dev/null 2>&1 || true ;;
    dnf) dnf install -y $NEED >/dev/null 2>&1 || true ;;
    pacman) pacman -S --noconfirm $NEED >/dev/null 2>&1 || true ;;
  esac
  # The ca-certificates postinst normally does this; force it in case the
  # package was present but the bundle had never been generated.
  have update-ca-certificates && update-ca-certificates >/dev/null 2>&1 || true
fi
have curl || have wget || fail no-downloader 12
[ -s /etc/ssl/certs/ca-certificates.crt ] || fail no-ca-certs 20
fetch() { # fetch <url> <dest>
  if have curl; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi
}

# 2. Install Docker unless it is already present.
if ! have docker; then
  fetch https://get.docker.com /tmp/get-docker.sh || fail download 11
  sh /tmp/get-docker.sh || fail installer 13
  rm -f /tmp/get-docker.sh
fi
have docker || fail docker-missing 14

# 3. Ensure the docker group exists before touching membership.
groupadd -f docker 2>/dev/null || true
getent group docker >/dev/null 2>&1 || fail groupadd 15

# 4. Add the human who launched us.
TARGET=""
if [ -n "${PKEXEC_UID:-}" ]; then TARGET="$(id -nu "$PKEXEC_UID" 2>/dev/null || true)"; fi
[ -n "$TARGET" ] || TARGET="${SUDO_USER:-}"
[ -n "$TARGET" ] || TARGET="$(logname 2>/dev/null || true)"
[ -n "$TARGET" ] || fail no-user 16
usermod -aG docker "$TARGET" || fail usermod 17

# 5. Start the daemon before probing compose/GPU, which both need it.
if have systemctl; then
  systemctl enable --now docker || true
elif have service; then
  service docker start || true
fi

# 6. Guarantee Compose v2. The distro package is tried first; the official
#    plugin binary is the fallback and works no matter how Docker was installed.
if ! docker compose version >/dev/null 2>&1; then
  case "$PKG" in
    apt) apt-get install -y docker-compose-plugin >/dev/null 2>&1 || true ;;
    dnf) dnf install -y docker-compose-plugin >/dev/null 2>&1 || true ;;
    pacman) pacman -S --noconfirm docker-compose >/dev/null 2>&1 || true ;;
  esac
fi
if ! docker compose version >/dev/null 2>&1; then
  DEST=/usr/local/lib/docker/cli-plugins
  mkdir -p "$DEST"
  fetch "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
        "$DEST/docker-compose" || true
  [ -s "$DEST/docker-compose" ] && chmod 0755 "$DEST/docker-compose"
fi
docker compose version >/dev/null 2>&1 || fail compose 18

# 7. NVIDIA Container Toolkit — only when there is a GPU driver but Docker
#    can't reach it. Never fatal: without it we fall back to the cloud engine.
if have nvidia-smi && ! docker info 2>/dev/null | grep -qi nvidia; then
  case "$PKG" in
    apt)
      KEYRING=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
      fetch https://nvidia.github.io/libnvidia-container/gpgkey /tmp/nv.key && \
        gpg --dearmor -o "$KEYRING" /tmp/nv.key 2>/dev/null || true
      rm -f /tmp/nv.key
      fetch https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list /tmp/nv.list && \
        sed "s#deb https://#deb [signed-by=$KEYRING] https://#g" /tmp/nv.list \
          > /etc/apt/sources.list.d/nvidia-container-toolkit.list || true
      rm -f /tmp/nv.list
      apt-get update -qq || true
      apt-get install -y nvidia-container-toolkit >/dev/null 2>&1 || true
      ;;
    dnf)
      fetch https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo \
            /etc/yum.repos.d/nvidia-container-toolkit.repo || true
      dnf install -y nvidia-container-toolkit >/dev/null 2>&1 || true
      ;;
  esac
  if have nvidia-ctk; then
    nvidia-ctk runtime configure --runtime=docker >/dev/null 2>&1 || true
    if have systemctl; then systemctl restart docker || true
    elif have service; then service docker restart || true; fi
  fi
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
            "no-ca-certs" => "This machine has no TLS certificate bundle, so nothing can be \
                downloaded over HTTPS. Install it, then reopen FinalRound:\n\
                \u{2022} Debian/Ubuntu:  sudo apt install ca-certificates\n\
                \u{2022} Fedora/RHEL:    sudo dnf install ca-certificates"
                .to_string(),
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
        DockerAccess::Ready | DockerAccess::ViaGroup if compose_prefix().is_some() => {
            Ok(InstallOutcome {
                ready: true,
                message: "Docker and Compose are installed and running.".into(),
            })
        }
        // Engine fine, Compose still absent — say so instead of reporting success
        // and letting start_stack fail again with the same message.
        DockerAccess::Ready | DockerAccess::ViaGroup => Ok(InstallOutcome {
            ready: false,
            message: "Docker is running, but Docker Compose could not be installed. \
                      Install it manually and reopen FinalRound:  \
                      sudo apt install docker-compose-plugin"
                .into(),
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
