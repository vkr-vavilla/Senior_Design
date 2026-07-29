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
      status.textContent = "Docker is required.";
      if (err.action === "start") {
        offerInstall(
          "Start Docker",
          "install_docker",
          "FinalRound runs its services in Docker, which is installed but not running. " +
            "FinalRound will start Docker and wait for it to come up — on the first " +
            "launch Docker itself may ask for permission, which can take a minute."
        );
      } else if (err.action === "relogin") {
        // Deliberately no action button: nothing this app can do from inside the
        // current login session will grant the group, so offering a button here
        // is what produced the install/restart loop.
        status.textContent = "One more step.";
        showError(
          (err.message || "Docker isn't reachable.") +
            "\n\nYour account needs to be in the 'docker' group. If you just added it, " +
            "log out and back in (or reboot) and reopen FinalRound.\n\n" +
            "To add it manually:\n  sudo groupadd -f docker\n  sudo usermod -aG docker $USER",
          { notice: true, retry: true }
        );
      } else {
        offerInstall(
          "Install Docker",
          "install_docker",
          "FinalRound runs its services in Docker, which isn't installed. " +
            "FinalRound can install it for you using Docker's official installer " +
            "(get.docker.com on Linux, Docker Desktop on macOS). " +
            "You'll be asked for your admin password."
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
