#!/usr/bin/env node
/**
 * Run an npm script across every workspace, tolerating the case where no
 * workspaces exist yet.
 *
 * Why this exists: `npm run <script> --workspaces --if-present` fails outright
 * with "No workspaces found!" when apps/ and packages/ are empty. The
 * `--if-present` flag only suppresses a missing *script* inside an existing
 * workspace — it does not suppress the absence of workspaces themselves. Since
 * this repository is scaffolded before any application code lands, the plain
 * command would make `npm run lint`, `npm test`, and `npm run build` fail on a
 * fresh clone.
 *
 * Delete this and inline `npm run <script> --workspaces --if-present` back into
 * package.json once apps/api and apps/web both exist.
 *
 *   node scripts/run-workspaces.mjs <script-name>
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = process.argv[2];

if (!script) {
  console.error('usage: node scripts/run-workspaces.mjs <script-name>');
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));

/**
 * Resolve workspace globs to concrete directories.
 *
 * Only the `dir/*` form used by this repository is handled — deliberately, to
 * avoid pulling in a glob dependency for a script whose whole purpose is to be
 * deleted later. A workspace counts only if it actually contains a package.json.
 */
function findWorkspaces(patterns = []) {
  const found = [];

  for (const pattern of patterns) {
    if (!pattern.endsWith('/*')) {
      console.warn(`warning: unsupported workspace pattern "${pattern}" — ignored`);
      continue;
    }

    const base = join(repoRoot, pattern.slice(0, -2));
    if (!existsSync(base)) continue;

    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(base, entry.name, 'package.json'))) {
        found.push(`${pattern.slice(0, -2)}/${entry.name}`);
      }
    }
  }

  return found;
}

const workspaces = findWorkspaces(pkg.workspaces);

if (workspaces.length === 0) {
  console.log(`No workspaces found yet — nothing to run for "${script}".`);
  process.exit(0);
}

console.log(`Running "${script}" in: ${workspaces.join(', ')}`);

// Node 22 on Windows refuses to spawn .cmd shims without a shell, so npm needs
// shell:true there. The script name comes from this repo's own package.json,
// so there is no untrusted input reaching the shell.
const result = spawnSync('npm', ['run', script, '--workspaces', '--if-present'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
