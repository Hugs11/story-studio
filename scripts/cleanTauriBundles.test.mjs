import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cleanTauriBundleDir, resolveTauriBundleDir } from './clean-tauri-bundles.mjs';

test('le nettoyage retire uniquement les anciens bundles Tauri', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'story-studio-clean-bundles-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundleDir = resolveTauriBundleDir(workspace);
  const preserved = join(workspace, 'src-tauri', 'target', 'release', 'deps', 'keep.txt');
  await mkdir(join(bundleDir, 'nsis'), { recursive: true });
  await mkdir(join(bundleDir, 'msi'), { recursive: true });
  await mkdir(join(workspace, 'src-tauri', 'target', 'release', 'deps'), { recursive: true });
  await writeFile(join(bundleDir, 'nsis', 'old.exe'), 'stale');
  await writeFile(join(bundleDir, 'msi', 'old.msi'), 'stale');
  await writeFile(preserved, 'keep');

  assert.deepEqual(await cleanTauriBundleDir(workspace), { bundleDir, removed: true });
  await assert.rejects(access(bundleDir), { code: 'ENOENT' });
  await access(preserved);
});

test('un dossier de bundle absent est un no-op explicite', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'story-studio-clean-bundles-empty-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundleDir = resolveTauriBundleDir(workspace);
  assert.deepEqual(await cleanTauriBundleDir(workspace), { bundleDir, removed: false });
});

test('un fichier à la place du dossier de bundle est refusé', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'story-studio-clean-bundles-file-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const bundleDir = resolveTauriBundleDir(workspace);
  await mkdir(join(workspace, 'src-tauri', 'target', 'release'), { recursive: true });
  await writeFile(bundleDir, 'not a directory');
  await assert.rejects(cleanTauriBundleDir(workspace), /bundle non régulier/);
});
