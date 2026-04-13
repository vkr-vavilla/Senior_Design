import subprocess
import time
import os
import requests
import threading

PRIMARY_MODEL = os.getenv("VLLM_PRIMARY_MODEL", "Qwen/Qwen2.5-7B-Instruct")
FALLBACK_MODEL = os.getenv("VLLM_FALLBACK_MODEL", "google/gemma-7b-it")
PRIMARY_PORT = int(os.getenv("VLLM_PRIMARY_PORT", "8000"))
FALLBACK_PORT = int(os.getenv("VLLM_FALLBACK_PORT", "8001"))

VLLM_ARGS = [
    "--max-num-seqs", "64",
    "--gpu-memory-utilization", "0.95",
    "--enforce-eager",
    "--max-model-len", "4096",
]


class VLLMManager:
    def __init__(self):
        self.process = None
        self.active_url = None
        self.active_model = None
        self._lock = threading.Lock()
        self._switching = False

    def start_primary(self):
        print(f"[VLLMManager] Starting primary model: {PRIMARY_MODEL}")
        self._start_model(PRIMARY_MODEL, PRIMARY_PORT)
        self.active_url = f"http://localhost:{PRIMARY_PORT}/v1"
        self.active_model = PRIMARY_MODEL
        print(f"[VLLMManager] Primary ready at {self.active_url}")

    def switch_to_fallback(self):
        with self._lock:
            if self._switching:
                return  # already switching
            if self.active_model == FALLBACK_MODEL:
                return  # already on fallback
            self._switching = True

        print(f"[VLLMManager] Primary failed. Killing process and switching to fallback: {FALLBACK_MODEL}")
        self._kill_current()
        self._start_model(FALLBACK_MODEL, FALLBACK_PORT)
        self.active_url = f"http://localhost:{FALLBACK_PORT}/v1"
        self.active_model = FALLBACK_MODEL
        self._switching = False
        print(f"[VLLMManager] Fallback ready at {self.active_url}")

    def is_on_fallback(self):
        return self.active_model == FALLBACK_MODEL

    def _start_model(self, model: str, port: int):
        cmd = [
            "python", "-m", "vllm.entrypoints.openai.api_server",
            "--model", model,
            "--port", str(port),
        ] + VLLM_ARGS
        self.process = subprocess.Popen(cmd)
        self._wait_until_ready(f"http://localhost:{port}", timeout=180)

    def _kill_current(self):
        if self.process and self.process.poll() is None:
            print("[VLLMManager] Terminating current vLLM process...")
            self.process.terminate()
            try:
                self.process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            print("[VLLMManager] Process terminated.")

    def _wait_until_ready(self, base_url: str, timeout: int = 180):
        print(f"[VLLMManager] Waiting for vLLM at {base_url} ...")
        for _ in range(timeout):
            try:
                # /v1/models only responds after the model is fully loaded
                r = requests.get(f"{base_url}/v1/models", timeout=2)
                if r.ok:
                    return
            except Exception:
                pass
            time.sleep(1)
        raise RuntimeError(f"vLLM at {base_url} did not become ready in {timeout}s")

    def shutdown(self):
        self._kill_current()


# Singleton
vllm_manager = VLLMManager()
