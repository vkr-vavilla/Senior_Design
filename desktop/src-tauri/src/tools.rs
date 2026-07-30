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

/// The .app bundles whose internal CLIs we care about, with the bundle
/// identifier used to locate them through Spotlight when they aren't in any of
/// the usual folders.
/// Not cfg-gated: the macOS installer paths in installer.rs are compiled on
/// every target (they're guarded at runtime by `cfg!`), so the names they
/// reference have to exist everywhere.
pub const DOCKER_APP: (&str, &str) = ("Docker", "com.docker.docker");
pub const OLLAMA_APP: (&str, &str) = ("Ollama", "com.electron.ollama");

/// Directories to search beyond whatever PATH we inherited. Order matters:
/// package-manager locations first, then app-bundle internals.
///
/// The bundle locations are resolved at call time rather than hardcoded to
/// /Applications: a Mac where the user (or a managed-device policy) put Docker
/// or Ollama in ~/Applications otherwise looks like a machine with neither
/// installed.
#[cfg(target_os = "macos")]
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = [
        "/usr/local/bin",  // Docker Desktop CLI symlink, Intel homebrew
        "/opt/homebrew/bin", // Apple Silicon homebrew
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ]
    .iter()
    .map(PathBuf::from)
    .collect();

    // Docker Desktop's real binaries — present whenever Docker.app is
    // installed, even if the user declined the /usr/local/bin symlinks.
    // Ollama ships its CLI inside its bundle too: /usr/local/bin/ollama only
    // appears after the user clicks "Install command line" in Ollama's UI, so
    // on a fresh install the in-bundle copy is the only one that exists.
    for (name, _) in [DOCKER_APP, OLLAMA_APP] {
        if let Some(app) = find_app_in_dirs(name) {
            dirs.extend(app_bin_dirs(&app));
        }
    }
    dirs
}

#[cfg(not(target_os = "macos"))]
fn extra_dirs() -> Vec<PathBuf> {
    [
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/snap/bin", // Ubuntu snap-installed docker
        "/opt/homebrew/bin",
    ]
    .iter()
    .map(PathBuf::from)
    .collect()
}

/// Folders macOS itself treats as application directories, most specific first.
#[cfg(target_os = "macos")]
fn app_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    dirs.extend(
        ["/Applications", "/Applications/Utilities", "/System/Applications"]
            .iter()
            .map(PathBuf::from),
    );
    dirs
}

/// The directories inside an .app that hold command-line executables.
/// Meaningless off macOS, but see DOCKER_APP above for why it's still compiled.
pub fn app_bin_dirs(app: &Path) -> Vec<PathBuf> {
    let contents = app.join("Contents");
    vec![
        contents.join("Resources").join("bin"),
        contents.join("Resources"),
        contents.join("MacOS"),
    ]
}

#[cfg(target_os = "macos")]
fn is_app_bundle(p: &Path) -> bool {
    p.join("Contents").join("Info.plist").is_file()
}

/// Cheap lookup: just stat the well-known application folders. Used on the hot
/// path (every `find` call) so it must never spawn a process.
#[cfg(target_os = "macos")]
fn find_app_in_dirs(app_name: &str) -> Option<PathBuf> {
    let bundle = format!("{app_name}.app");
    app_search_dirs()
        .into_iter()
        .map(|d| d.join(&bundle))
        .find(|p| is_app_bundle(p))
}

/// Absolute path to an installed .app, wherever it lives.
///
/// Folder scan first, then Spotlight by bundle identifier, which finds it even
/// on a machine where someone keeps applications somewhere unusual. Spotlight
/// is deliberately the fallback: it costs a subprocess, and it returns nothing
/// on volumes with indexing disabled, so it can only ever add results.
#[cfg(target_os = "macos")]
pub fn find_app(app_name: &str, bundle_id: &str) -> Option<PathBuf> {
    if let Some(found) = find_app_in_dirs(app_name) {
        return Some(found);
    }
    let out = Command::new("/usr/bin/mdfind")
        .arg(format!("kMDItemCFBundleIdentifier == '{bundle_id}'"))
        .output()
        .ok()?;
    let hits: Vec<PathBuf> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| PathBuf::from(l.trim()))
        .filter(|p| is_app_bundle(p) && !is_stashed_copy(p))
        .collect();
    // An installed app sits in some "Applications" folder. Prefer one that
    // does; only fall back to an unusual location if that's all there is.
    hits.iter()
        .find(|p| p.parent().and_then(|d| d.file_name()) == Some("Applications".as_ref()))
        .or_else(|| hits.first())
        .cloned()
}

/// Spotlight also indexes copies that aren't installs: Docker Desktop leaves a
/// half-unpacked Docker.app under ~/Library/Application Support/…/in_progress,
/// and a mounted .dmg or the Trash look just as much like a real bundle.
/// Launching one of those would be worse than reporting nothing found.
#[cfg(target_os = "macos")]
fn is_stashed_copy(p: &Path) -> bool {
    let s = p.to_string_lossy();
    ["/Library/", "/.Trash", "/Volumes/", "/private/var/folders/"]
        .iter()
        .any(|frag| s.contains(frag))
}

#[cfg(not(target_os = "macos"))]
pub fn find_app(_app_name: &str, _bundle_id: &str) -> Option<PathBuf> {
    None
}

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
    for dir in extra_dirs() {
        let candidate = dir.join(name);
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

pub fn is_executable(p: &Path) -> bool {
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
    let fallback = extra_dirs();
    for p in fallback.iter().cloned().chain(home_dirs()) {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| {
        OsString::from(
            fallback
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(":"),
        )
    })
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
