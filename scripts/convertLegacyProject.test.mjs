import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  convertLegacyProjectData,
  convertLegacyProjectFile,
} from './convert-legacy-project.mjs';

const CLI_PATH = fileURLToPath(new URL('./convert-legacy-project.mjs', import.meta.url));

function runCli(args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('convertLegacyProjectData maps legacy rootItems and menus to rootEntries only', () => {
  const converted = convertLegacyProjectData({
    name: 'Legacy pack',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [{
      id: 'story-root',
      type: 'story',
      name: 'Root story',
      audio: 'story.mp3',
      itemAudio: 'item.mp3',
      itemImage: 'item.png',
    }],
    menus: [{
      id: 'menu-root',
      name: 'Menu',
      audio: 'menu.mp3',
      image: 'menu.png',
      items: [{
        id: 'story-child',
        type: 'story',
        name: 'Child story',
        audio: 'child.mp3',
        itemAudio: 'child-item.mp3',
        itemImage: 'child.png',
      }],
    }],
  });

  assert.equal(converted.schemaVersion, 3);
  assert.equal(Object.hasOwn(converted, 'rootItems'), false);
  assert.equal(Object.hasOwn(converted, 'menus'), false);
  assert.equal(converted.rootEntries.length, 2);
  assert.equal(converted.rootEntries[0].id, 'story-root');
  assert.equal(converted.rootEntries[1].id, 'menu-root');
  assert.equal(converted.rootEntries[1].children[0].id, 'story-child');
});

test('convertLegacyProjectData prefers non-empty legacy fields over empty rootEntries', () => {
  const converted = convertLegacyProjectData({
    schemaVersion: 2,
    name: 'Legacy with empty rootEntries',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
    menus: [{
      id: 'menu-root',
      name: 'Menu',
      audio: 'menu.mp3',
      image: 'menu.png',
      items: [{ id: 'story-child', type: 'story', name: 'Child story' }],
    }],
  });

  assert.equal(converted.rootEntries.length, 1);
  assert.equal(converted.rootEntries[0].id, 'menu-root');
});

test('convertLegacyProjectFile refuses overwrite unless forced', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-convert-'));
  const input = path.join(dir, 'legacy.mbah');
  const output = path.join(dir, 'converted.mbah');
  await writeFile(input, JSON.stringify({ name: 'Legacy', projectType: 'pack', globalOptions: {}, rootItems: [] }), 'utf8');
  await writeFile(output, '{}', 'utf8');

  await assert.rejects(
    () => convertLegacyProjectFile({ inputPath: input, outputPath: output, force: false }),
    /Output already exists/,
  );

  await convertLegacyProjectFile({ inputPath: input, outputPath: output, force: true });
  const converted = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(converted.schemaVersion, 3);
});

test('--force overwrites an existing output file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-convert-force-'));
  const input = path.join(dir, 'legacy.mbah');
  const output = path.join(dir, 'converted.mbah');
  await writeFile(input, JSON.stringify({ name: 'Legacy', projectType: 'pack', globalOptions: {}, rootItems: [] }), 'utf8');
  await writeFile(output, JSON.stringify({ marker: 'previous content' }), 'utf8');

  await convertLegacyProjectFile({ inputPath: input, outputPath: output, force: true });

  const converted = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(converted.schemaVersion, 3);
  assert.equal(Object.hasOwn(converted, 'marker'), false);
});

test('--in-place without --no-backup creates a timestamped .bak alongside the input', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-convert-bak-'));
  const input = path.join(dir, 'legacy.mbah');
  await writeFile(input, JSON.stringify({ name: 'Legacy', projectType: 'pack', globalOptions: {}, rootItems: [] }), 'utf8');

  const result = await convertLegacyProjectFile({
    inputPath: input,
    outputPath: input,
    force: true,
    backup: true,
  });

  assert.ok(result.backup, 'le helper doit retourner un chemin de backup');
  assert.equal(path.dirname(result.backup), dir);
  assert.ok(result.backup.endsWith('.bak'), `le backup doit finir par .bak: ${result.backup}`);
  assert.match(path.basename(result.backup), /^legacy\.mbah\.\d{8}-\d{6}\.bak$/);

  const entries = await readdir(dir);
  const baks = entries.filter((name) => name.endsWith('.bak'));
  assert.equal(baks.length, 1, `un seul .bak attendu, trouvé: ${baks.join(', ')}`);
});

test('--in-place --no-backup does not create a .bak', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-convert-nobak-'));
  const input = path.join(dir, 'legacy.mbah');
  await writeFile(input, JSON.stringify({ name: 'Legacy', projectType: 'pack', globalOptions: {}, rootItems: [] }), 'utf8');

  const result = await convertLegacyProjectFile({
    inputPath: input,
    outputPath: input,
    force: true,
    backup: false,
  });

  assert.equal(result.backup, null);

  const entries = await readdir(dir);
  const baks = entries.filter((name) => name.endsWith('.bak'));
  assert.equal(baks.length, 0, `aucun .bak attendu, trouvé: ${baks.join(', ')}`);
});

test('CLI exits with a clear error and non-zero code when the input file does not exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-convert-missing-'));
  const missing = path.join(dir, 'does-not-exist.mbah');

  const result = runCli([missing]);

  assert.notEqual(result.status, 0, 'exit code attendu ≠ 0');
  const message = `${result.stdout}\n${result.stderr}`;
  assert.match(message, /Conversion failed/);
  assert.match(message, /ENOENT|no such file/i);
});

test('CLI accepts an output path without .mbah extension but emits a warning on stderr', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-convert-ext-'));
  const input = path.join(dir, 'legacy.mbah');
  const output = path.join(dir, 'converted.json');
  await writeFile(input, JSON.stringify({ name: 'Legacy', projectType: 'pack', globalOptions: {}, rootItems: [] }), 'utf8');

  const result = runCli([input, output]);

  assert.equal(result.status, 0, `exit code 0 attendu, reçu ${result.status} (stderr: ${result.stderr})`);
  assert.match(result.stdout, /Converted:/);
  assert.match(result.stderr, /Warning:.*\.mbah/i, `warning attendu sur stderr, reçu: ${result.stderr}`);

  const converted = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(converted.schemaVersion, 3);
});
