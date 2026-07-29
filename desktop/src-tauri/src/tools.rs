//! External-binary resolution.
//!
//! A GUI-launched app does NOT inherit your shell's PATH. On macOS, launchd
//! hands .app bundles `/usr/bin:/bin:/usr/sbin:/sbin` — which excludes
//! `/usr/local/bin`, exactly where Docker Desktop puts the `docker` CLI. On
//! Linux, an AppImage started from a file manager gets a similarly minimal
//! environment. `Command::new("docker")` then fails to spawn with ENOENT
//! ("No such file or directory (os error 2)"), which is indistinguishable from
//! "the tool is installed but not running" unless we look closer.
//!
//! So: never resolve a tool by bare name. Search the PATH we were given, then
//! the well-known absolute locations, and run children with an augmented PATH
//! so anything *they* shell out to is reachable too.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Directories to search beyond whatever PATH we inherited. Order matters:
/// package-manager locations first, then app-bundle internals.
#[cfg(target_os = "macos")]
const EXTRA_DIRS: &[&str] = &[
    "/usr/local/bin",                                  // Docker Desktop CLI symlink, Intel homebrew
    "/opt/homebrew/bin",                               // Apple Silicon homebrew
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    // Docker Desktop's real binaries — present whenever Docker.app is
    // installed, even if the user declined the /usr/local/bin symlinks.
    "/Applications/Docker.app/Contents/Resources/bin",
    // Ollama ships its CLI inside the bundle. /usr/local/bin/ollama only
    // appears after the user clicks "Install command line" in Ollama's UI, so
    // on a fresh install this is the only copy that exists.
    "/Applications/Ollama.app/Contents/Resources",
    "/Applications/Ollama.app/Contents/MacOS",
];

#[cfg(not(target_os = "macos"))]
const EXTRA_DIRS: &[&str] = &[
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/snap/bin", // Ubuntu snap-installed docker
    "/opt/homebrew/bin",
];

/// Per-user install locations, which need $HOME expanded so they can't live in
/// the const above. Docker Desktop 4.18+ puts its CLI in ~/.docker/bin and adds
/// it to PATH from a shell profile — which a GUI app never sources, so without
/// this a machine that plainly has Docker looks like it doesn't.
fn home_dirs() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) else {
        return Vec::new();
    };
    let home = PathBuf::from(home);
    vec![
        home.join(".docker").join("bin"),
        home.join(".local").join("bin"),
        home.join("bin"),
    ]
}

/// Absolute path to `name`, or None if it isn't installed anywhere we look.
pub fn find(name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join(name);
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    for dir in EXTRA_DIRS {
        let candidate = Path::new(dir).join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    for dir in home_dirs() {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable(p: &Path) -> bool {
    // is_file() follows symlinks, which is what we want for /usr/local/bin
    // entries that point into an app bundle.
    if !p.is_file() {
        return false;
    }
    // Also require the exec bit: a same-named data file (Ollama.app ships both
    // `ollama` the binary and `ollama.png` beside it) or a partially-extracted
    // download would otherwise be returned and then fail with EACCES at spawn.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(p)
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    true
}

/// PATH for child processes: our own plus every well-known dir. Without this,
/// `docker compose` can miss its CLI plugins and scripts can miss their tools.
pub fn augmented_path() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for p in EXTRA_DIRS.iter().map(PathBuf::from).chain(home_dirs()) {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| OsString::from(EXTRA_DIRS.join(":")))
}

/// A Command for `name`, resolved absolutely and given a full PATH.
pub fn command(name: &str) -> Result<Command, String> {
    let exe = find(name).ok_or_else(|| missing_message(name))?;
    let mut cmd = Command::new(exe);
    cmd.env("PATH", augmented_path());
    Ok(cmd)
}

/// True when the tool exists on this machine at all.
pub fn exists(name: &str) -> bool {
    find(name).is_some()
}

/// Actionable per-tool guidance — these strings reach the user's splash screen.
fn missing_message(name: &str) -> String {
    match name {
        "docker" => "Docker isn't installed on this machine.".to_string(),
        "curl" | "wget" => format!(
            "Neither curl nor wget is available, so FinalRound can't download its runtime.\n\
             Install one of them, then reopen FinalRound:\n\
             \u{2022} Debian/Ubuntu:  sudo apt install curl\n\
             \u{2022} Fedora/RHEL:    sudo dnf install curl\n\
             (missing: {name})"
        ),
        "ollama" => "Ollama is installed but its command line isn't available.\n\
             Open Ollama and choose \"Install command line\" when prompted, \
             then reopen FinalRound."
            .to_string(),
        other => format!("Required tool '{other}' was not found on this machine."),
    }
}

/// Download `url` to `dest` using whichever downloader this machine has.
/// Fresh minimal Linux installs frequently ship wget but not curl (or neither),
/// so we can't hard-depend on curl.
pub fn download(url: &str, dest: &Path) -> Result<(), String> {
    let dest_str = dest.to_string_lossy().to_string();

    if let Some(curl) = find("curl") {
        let out = Command::new(curl)
            .env("PATH", augmented_path())
            .args(["-fL", "--retry", "2", "-o", &dest_str, url])
            .output()
            .map_err(|e| format!("failed to run curl: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        return Err(format!(
            "Download failed. Check your internet connection.\n{}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        ));
    }

    if let Some(wget) = find("wget") {
        let out = Command::new(wget)
            .env("PATH", augmented_path())
            .args(["-q", "-O", &dest_str, url])
            .output()
            .map_err(|e| format!("failed to run wget: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        return Err(format!(
            "Download failed. Check your internet connection.\n{}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("")
        ));
    }

    Err(missing_message("curl"))
}


/// Quote a single argument for /bin/sh.
pub fn shell_quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// Run `cmdline` through /bin/sh.
pub fn sh_command(cmdline: &str) -> Result<Command, String> {
    let mut cmd = command("sh")?;
    cmd.arg("-c").arg(cmdline);
    Ok(cmd)
}

/// Run `cmdline` with `group` added to the process's group list.
///
/// `sg` reads /etc/group at exec time rather than inheriting the caller's
/// cached supplementary groups, so this makes a brand-new `docker` group
/// membership usable immediately — no logout, no reboot.
pub fn sg_command(group: &str, cmdline: &str) -> Result<Command, String> {
    let mut cmd = command("sg")?;
    cmd.arg(group).arg("-c").arg(cmdline);
    Ok(cmd)
}
