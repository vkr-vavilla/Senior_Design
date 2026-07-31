/**
 * Copies the Silero VAD runtime out of node_modules and into public/vad/.
 *
 * @ricky0123/vad-web loads three things over the network at runtime — an
 * AudioWorklet bundle, the Silero ONNX weights, and the onnxruntime-web WASM
 * binary — and by default it fetches them from a CDN. That is wrong for us
 * twice over: the desktop app is expected to work on a machine with no
 * internet, and a CDN fetch inside the Tauri webview is one more thing that
 * can silently fail mid-interview. Copying them into public/ makes them
 * same-origin static files that Next serves itself.
 *
 * Runs from `predev` and `prebuild`, so both the dev container and the
 * production build (docker-compose.local.yml runs `npm run build`) get them
 * without anyone having to remember a step. The copies are gitignored —
 * node_modules is the source of truth, and re-running this is the only
 * supported way to refresh them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(projectRoot, 'public', 'vad');

/**
 * Locate a package's directory on disk by walking node_modules upward.
 *
 * Deliberately not require.resolve: onnxruntime-web's "exports" map has no
 * "./package.json" entry, so the usual resolve-the-manifest trick throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. We only want to read files out of the
 * package's dist/, never to import it, so the filesystem is the right lookup.
 */
function packageDir(pkg) {
  for (let dir = projectRoot; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', pkg);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) break;
  }
  console.error(`[vad-assets] cannot find ${pkg} in node_modules — run npm install`);
  process.exit(1);
}

const assets = [
  // The VAD itself: worklet that slices mic audio into 512-sample frames, and
  // the Silero weights. "legacy" (not v5) because that is what vad-web still
  // defaults to and what its default thresholds are tuned against.
  ...['vad.worklet.bundle.min.js', 'silero_vad_legacy.onnx'].map((f) => ({
    from: path.join(packageDir('@ricky0123/vad-web'), 'dist', f),
    to: path.join(outDir, f),
  })),
  // onnxruntime-web's WASM backend. vad-web imports "onnxruntime-web/wasm",
  // whose bundled build references exactly this pair — the much larger jsep /
  // asyncify / jspi variants are for WebGPU and are deliberately not copied.
  ...['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map((f) => ({
    from: path.join(packageDir('onnxruntime-web'), 'dist', f),
    to: path.join(outDir, f),
  })),
];

fs.mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const { from, to } of assets) {
  if (!fs.existsSync(from)) {
    console.error(`[vad-assets] missing ${from} — run npm install`);
    process.exit(1);
  }
  // Skip unchanged files: the WASM binary is ~13 MB and this runs on every
  // container start, where the bind-mounted public/ already has it.
  const src = fs.statSync(from);
  const dst = fs.existsSync(to) ? fs.statSync(to) : null;
  if (dst && dst.size === src.size && dst.mtimeMs >= src.mtimeMs) continue;
  fs.copyFileSync(from, to);
  copied++;
}

console.log(
  copied === 0
    ? '[vad-assets] public/vad up to date'
    : `[vad-assets] copied ${copied} file(s) to public/vad`
);
