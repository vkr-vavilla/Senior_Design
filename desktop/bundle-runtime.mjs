// Builds src-tauri/runtime.tar.gz — the stack sources the installed app runs.
//
// Shipping the runtime inside the installer means a fresh machine needs no
// network and no curl/wget at first launch (a stock ubuntu:24.04 has neither),
// and the app can never run a runtime from a different version than itself.
//
// Runs from tauri.conf.json's beforeBuildCommand. Uses the `tar` CLI, which is
// present on all three GitHub runners (Windows 10+ ships bsdtar as tar.exe).
//
// The layout inside the archive matches GitHub's source tarball
// (Senior_Design-main/...) so the download fallback and this path extract to
// the same place.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = resolve(import.meta.dirname, 'src-tauri', 'runtime.tar.gz');

// Everything compose needs to build and run the stack — and nothing else.
// Excludes are what would otherwise balloon the archive or leak local state.
const INCLUDE = [
  'docker-compose.local.yml',
  'setup_local.sh',
  'backend',
  'frontend',
  'scripts',
  'ollama',
];
// Basename matches — these never contain anything we want, at any depth.
const EXCLUDE_DIRS = ['node_modules', '.next', '__pycache__', '.venv', 'venv', '.git'];

// Repo-relative prefixes. Anchored on purpose: an earlier version excluded any
// directory called "models" and silently dropped backend/models/, which is real
// Python source the backend imports at startup.
const EXCLUDE_PATHS = [
  'ollama/models',          // *.gguf weights, 4.7 GB — fetched at first run
  'backend/kokoro_models',  // 338 MB ONNX, unused since the Google TTS switch
  'training/artifacts',     // local LoRA adapter
];

// Suffix matches — weights and local state, never source.
const EXCLUDE_SUFFIX = [
  '.pyc', '.gguf', '.onnx', '.safetensors', '.bin',
  '.DS_Store', '/.env', 'tsconfig.tsbuildinfo', 'package-lock 2.json',
];

const rel = (p) => p.slice(repo.length + 1).split('\\').join('/');
function keep(p) {
  if (p === repo) return true;
  const r = rel(p);
  if (r.split('/').some((seg) => EXCLUDE_DIRS.includes(seg))) return false;
  if (EXCLUDE_PATHS.some((x) => r === x || r.startsWith(x + '/'))) return false;
  if (EXCLUDE_SUFFIX.some((x) => r.endsWith(x))) return false;
  return true;
}

const stage = mkdtempSync(join(tmpdir(), 'finalround-runtime-'));
const root = join(stage, 'Senior_Design-main');
mkdirSync(root, { recursive: true });

try {
  for (const entry of INCLUDE) {
    const src = join(repo, entry);
    if (!existsSync(src)) {
      console.warn(`bundle-runtime: skipping missing ${entry}`);
      continue;
    }
    cpSync(src, join(root, entry), {
      recursive: true,
      dereference: true,
      filter: keep,
    });
  }

  execFileSync('tar', ['-czf', out, '-C', stage, 'Senior_Design-main'], {
    stdio: 'inherit',
  });
  console.log(`bundle-runtime: wrote ${out}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
