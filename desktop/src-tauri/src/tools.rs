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
    None
}

fn is_executable(p: &Path) -> bool {
    // is_file() follows symlinks, which is what we want for /usr/local/bin
    // entries that point into an app bundle.
    p.is_file()
}

/// PATH for child processes: our own plus every well-known dir. Without this,
/// `docker compose` can miss its CLI plugins and scripts can miss their tools.
pub fn augmented_path() -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for dir in EXTRA_DIRS {
        let p = PathBuf::from(dir);
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
