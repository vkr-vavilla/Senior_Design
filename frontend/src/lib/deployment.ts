/**
 * What this deployment can do — where the interviewer model can come from.
 *
 * "cloud" — no local engine behind the site, so interviews must run on the
 *           Gemini API with the user's own key.
 * "local" — vLLM (NVIDIA) or Ollama (Apple Silicon) is serving the fine-tuned
 *           model on this machine.
 *
 * Two sources, deliberately:
 *
 *  1. NEXT_PUBLIC_DEPLOYMENT, used for the very first render. Next.js inlines
 *     NEXT_PUBLIC_* at BUILD time, so this is only as correct as the build args
 *     — the hosted image was built without it and therefore rendered local mode
 *     while offering an engine that wasn't there.
 *  2. GET /config on the backend, which reports the engine it is actually
 *     configured for. This is authoritative and cannot drift from reality, so
 *     it overrides the build-time guess as soon as it arrives.
 */
export type Deployment = 'cloud' | 'local';

/** Build-time guess; correct on the desktop app, unreliable on the cloud. */
export const BUILD_TIME_DEPLOYMENT: Deployment =
  process.env.NEXT_PUBLIC_DEPLOYMENT === 'cloud' ? 'cloud' : 'local';

/** @deprecated Prefer useDeployment() — this is the build-time guess only. */
export const IS_CLOUD = BUILD_TIME_DEPLOYMENT === 'cloud';

export const DEFAULT_MODEL_SOURCE: 'local' | 'api' = IS_CLOUD ? 'api' : 'local';

/** Where users get a free Gemini key. */
export const GEMINI_KEY_URL = 'https://aistudio.google.com/apikey';

export interface DeploymentConfig {
  deployment: Deployment;
  localEngine: boolean;
  geminiKeyConfigured: boolean;
}

/** Ask the backend what it can do. Falls back to the build-time guess. */
export async function fetchDeploymentConfig(): Promise<DeploymentConfig> {
  const fallback: DeploymentConfig = {
    deployment: BUILD_TIME_DEPLOYMENT,
    localEngine: BUILD_TIME_DEPLOYMENT === 'local',
    geminiKeyConfigured: false,
  };
  try {
    const base = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';
    const res = await fetch(`${base}/config`, { cache: 'no-store' });
    if (!res.ok) return fallback;
    const data = await res.json();
    return {
      deployment: data.deployment === 'cloud' ? 'cloud' : 'local',
      localEngine: Boolean(data.local_engine),
      geminiKeyConfigured: Boolean(data.gemini_key_configured),
    };
  } catch {
    // Backend not up yet (the desktop app polls while it boots) — the guess is
    // right there, since the desktop build does set NEXT_PUBLIC_DEPLOYMENT.
    return fallback;
  }
}
