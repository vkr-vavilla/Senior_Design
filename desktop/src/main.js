// Splash controller. Uses the Tauri global API (withGlobalTauri) so no bundler
// is needed. Streams startup progress from the Rust supervisor, then navigates
// the window to the running frontend once the stack is up.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const fill = document.getElementById("fill");
const status = document.getElementById("status");
const errorEl = document.getElementById("error");
const retryBtn = document.getElementById("retry");
const spinner = document.getElementById("spinner");

listen("startup:progress", (event) => {
  const { pct, message } = event.payload;
  fill.style.width = `${pct}%`;
  status.textContent = message;
});

async function boot() {
  errorEl.style.display = "none";
  retryBtn.style.display = "none";
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
    status.textContent = "Couldn't start PrepAI.";
    errorEl.textContent = String(err);
    errorEl.style.display = "block";
    retryBtn.style.display = "inline-block";
  }
}

retryBtn.addEventListener("click", boot);
window.addEventListener("DOMContentLoaded", boot);
