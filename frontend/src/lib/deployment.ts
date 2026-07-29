/**
 * Which deployment this build is serving.
 *
 * "cloud"  — the hosted site. There is no GPU behind it, so the interviewer
 *            model can only come from the Gemini API and the user supplies
 *            their own key.
 * "local"  — the desktop app / self-hosted stack, where vLLM (NVIDIA) or
 *            Ollama (Apple Silicon) runs the fine-tuned model on-device.
 *
 * Set NEXT_PUBLIC_DEPLOYMENT=cloud on the hosted deployment. Anything else
 * (including unset) is treated as local, so a plain `docker compose up` keeps
 * working with no configuration.
 */
export const IS_CLOUD = process.env.NEXT_PUBLIC_DEPLOYMENT === 'cloud';

/** Cloud has no local engine to fall back on, so it must default to Gemini. */
export const DEFAULT_MODEL_SOURCE: 'local' | 'api' = IS_CLOUD ? 'api' : 'local';

/** Where users get a free Gemini key. */
export const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';
