/**
 * Installs the dashboard's dependencies, if the dashboard is present.
 *
 * Runs from `postinstall`, which means it also runs inside the Docker build,
 * where only package*.json has been copied and `dashboard/` does not exist yet.
 * A missing dashboard is therefore normal and must not fail the install - that
 * is what the original `[ -d dashboard ] && ... || true` guard did, before it
 * turned out to be bash-only and silently skip on Windows.
 *
 * Kept as a script rather than a package.json one-liner because both of those
 * details are worth stating where someone will read them.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dashboardDir = join(projectRoot, 'dashboard');

if (!existsSync(join(dashboardDir, 'package.json'))) {
  console.log('[postinstall] No dashboard directory; skipping its install.');
  process.exit(0);
}

// --ignore-scripts: the dashboard's own lifecycle scripts have no business
// running inside an install the parent package manager is already driving.
//
// cwd rather than `npm --prefix dashboard install`: with --prefix, npm treats
// the current directory as a package to install and writes `"openwa": "file:.."`
// into the dashboard's manifest, dragging the whole backend dependency tree into
// its lockfile on every install.
const result = spawnSync('npm', ['install', '--ignore-scripts'], {
  cwd: dashboardDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error('[postinstall] Failed to install dashboard dependencies:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);
