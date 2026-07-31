/**
 * Reinstall node_modules when package-lock.json has moved on.
 *
 * Both compose files bind-mount ./frontend over /app and keep node_modules in
 * an anonymous volume, so the source and the installed dependencies age
 * independently. Docker Compose carries anonymous volumes across container
 * recreation, which means `docker compose up` after a `git pull` gives you new
 * code sitting on top of whatever node_modules happened to be there before —
 * even if the image was rebuilt. Anything added to package.json since the
 * container was first created is simply missing, and the build dies on an
 * import that looks perfectly correct in the repo.
 *
 * So: stamp the lockfile's hash inside node_modules and reinstall when it no
 * longer matches. Costs one file read on the normal path.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = path.join(projectRoot, 'package-lock.json');
const stampFile = path.join(projectRoot, 'node_modules', '.deps-stamp');

const want = createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex');

// --stamp: the image build just ran `npm ci` itself, so record the hash and
// stop. Without this the first container start would reinstall for nothing.
if (process.argv.includes('--stamp')) {
  fs.writeFileSync(stampFile, want);
  console.log('[deps] stamped');
  process.exit(0);
}

const have = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : null;

if (have === want) {
  console.log('[deps] node_modules matches package-lock.json');
  process.exit(0);
}

console.log(
  have === null
    ? '[deps] no install stamp — installing dependencies'
    : '[deps] package-lock.json changed — reinstalling dependencies'
);

try {
  execFileSync('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
} catch {
  // Almost always no network. Say so plainly: the build that follows would
  // otherwise fail on a missing import and send someone hunting through
  // their own code for a problem that is not there.
  console.error(
    '[deps] npm ci failed. The app needs to download its dependencies once ' +
      'after an update — check this machine\'s internet connection and start again.'
  );
  process.exit(1);
}

fs.writeFileSync(stampFile, want);
console.log('[deps] dependencies up to date');
