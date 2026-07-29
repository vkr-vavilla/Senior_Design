// Splash controller. Uses the Tauri global API (withGlobalTauri) so no bundler
// is needed. Streams startup progress from the Rust supervisor, then navigates
// the window to the running frontend once the stack is up. When a prerequisite
// (Docker, Ollama) is missing, offers to install it in-app instead of just
// showing an error.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const fill = document.getElementById("fill");
const status = document.getElementById("status");
const errorEl = document.getElementById("error");
const retryBtn = document.getElementById("retry");
const installBtn = document.getElementById("install");
const spinner = document.getElementById("spinner");

listen("startup:progress", (event) => {
  const { pct, message } = event.payload;
  fill.style.width = `${pct}%`;
  status.textContent = message;
});

function showError(text, { notice = false, retry = true } = {}) {
  spinner.style.display = "none";
  errorEl.textContent = text;
  errorEl.classList.toggle("notice", notice);
  errorEl.style.display = "block";
  retryBtn.style.display = retry ? "inline-block" : "none";
}

function offerInstall(label, command, disclosure) {
  showError(disclosure, { retry: true });
  installBtn.textContent = label;
  installBtn.style.display = "inline-block";
  installBtn.onclick = () => runInstall(command);
}

async function runInstall(command) {
  installBtn.style.display = "none";
  retryBtn.style.display = "none";
  errorEl.style.display = "none";
  spinner.style.display = "block";
  status.textContent = "Installing… you may be asked for your admin password.";
  try {
    const outcome = await invoke(command);
    if (outcome.ready) {
      // Prerequisite is usable right now — go straight back into startup.
      boot();
    } else {
      // Installed, but this process can't use it yet (Linux: the new docker
      // group only applies to processes started after it was granted).
      status.textContent = "Almost there.";
      showError(outcome.message, { notice: true, retry: false });
    }
  } catch (err) {
    status.textContent = "Install failed.";
    showError(String(err));
  }
}

async function boot() {
  errorEl.style.display = "none";
  errorEl.classList.remove("notice");
  retryBtn.style.display = "none";
  installBtn.style.display = "none";
  spinner.style.display = "block";
  status.textContent = "Preparing…";
  fill.style.width = "0%";
  try {
    const url = await invoke("start_stack");
    status.textContent = "Ready — launching…";
    // Hand off the window to the live app.
    window.location.replace(url);
  } catch (err) {
    spinner.style.display = "none";
    // start_stack rejects with a typed error: { kind, message }.
    const kind = err && err.kind;
    if (kind === "missing_docker") {
      // Always lead with err.message, which names the piece that is actually
      // missing. Hardcoding "Docker isn't installed" here once told a user with
      // working Docker that Docker was absent, when Compose was the gap.
      const detail = err.message || "Docker isn't available.";
      if (err.action === "start") {
        status.textContent = "Docker isn't running.";
        offerInstall(
          "Start Docker",
          "install_docker",
          detail +
            " FinalRound will start it and wait — on first launch Docker itself may " +
            "ask for permission, which can take a minute."
        );
      } else if (err.action === "compose") {
        status.textContent = "Docker Compose is missing.";
        offerInstall(
          "Install Compose",
          "install_docker",
          detail +
            " Compose ships separately from the Docker engine, and some installs " +
            "(`apt install docker.io`, for one) leave it out. FinalRound can install " +
            "it for you — you'll be asked for your admin password."
        );
      } else if (err.action === "relogin") {
        // No action button on purpose: nothing this app can do from inside the
        // current login session grants the group, and offering a button here is
        // what produced the earlier install/restart loop.
        status.textContent = "One more step.";
        showError(
          detail +
            "\n\nYour account needs to be in the 'docker' group. If you just added it, " +
            "log out and back in (or reboot), then reopen FinalRound.\n\n" +
            "To add it manually:\n  sudo groupadd -f docker\n  sudo usermod -aG docker $USER",
          { notice: true, retry: true }
        );
      } else {
        status.textContent = "Docker is required.";
        offerInstall(
          "Install Docker",
          "install_docker",
          detail +
            " FinalRound can install it for you using Docker's official installer, " +
            "along with Compose and the permissions it needs. You'll be asked for " +
            "your admin password."
        );
      }
    } else if (kind === "missing_ollama") {
      status.textContent = "Ollama is required.";
      offerInstall(
        "Install Ollama",
        "install_ollama",
        "On Apple Silicon the interviewer model runs through Ollama, which " +
          "isn't installed or running. FinalRound can download it from ollama.com " +
          "and start it for you."
      );
    } else {
      status.textContent = "Couldn't start FinalRound.";
      showError((err && err.message) || String(err));
    }
  }
}

retryBtn.addEventListener("click", boot);
window.addEventListener("DOMContentLoaded", boot);
