#!/usr/bin/env node

import { mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = resolve(
  REPO_ROOT,
  process.argv[2] || 'linux-0.9.6/artifacts/04-linux-ubuntu22.04',
);
const image = 'localhost/story-studio-linux-bundles:ubuntu-22.04';

function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status}.`);
  return capture ? result.stdout.trim() : '';
}

async function main() {
  try {
    await stat(outputDir);
    throw new Error(`Output directory already exists: ${outputDir}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  run('podman', [
    'build',
    '--file',
    'packaging/linux/Containerfile',
    '--tag',
    image,
    '.',
  ]);
  const container = run('podman', ['create', image], { capture: true });
  try {
    await mkdir(outputDir, { recursive: true });
    run('podman', [
      'cp',
      `${container}:/workspace/src-tauri/target/release/bundle/.`,
      outputDir,
    ]);
  } finally {
    run('podman', ['rm', container]);
  }
  process.stdout.write(`Linux bundles copied to ${outputDir}\n`);
}

main().catch((error) => {
  process.stderr.write(`Linux bundle build failed: ${error.message}\n`);
  process.exitCode = 1;
});
