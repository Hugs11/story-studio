import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertVersionConsistency,
  readVersionSources,
} from './checkVersionConsistency.mjs';

const VERSION = '7.8.9';

function matchingSources() {
  return {
    'package.json': VERSION,
    'package-lock.json': VERSION,
    'src-tauri/Cargo.toml': VERSION,
    'src-tauri/Cargo.lock (story-studio)': VERSION,
    'src-tauri/tauri.conf.json': VERSION,
  };
}

async function createFixture(t, { omit } = {}) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'story-studio-version-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  await mkdir(path.join(rootDir, 'src-tauri'));

  const files = {
    'package.json': JSON.stringify({ version: VERSION }),
    'package-lock.json': JSON.stringify({
      version: VERSION,
      packages: { '': { version: VERSION } },
    }),
    'src-tauri/Cargo.toml': [
      '[package]',
      'name = "story-studio"',
      `version = "${VERSION}"`,
      '',
      '[dependencies]',
      'example = { version = "99.0.0" }',
    ].join('\n'),
    'src-tauri/Cargo.lock': [
      'version = 4',
      '',
      '[[package]]',
      'name = "example"',
      'version = "99.0.0"',
      '',
      '[[package]]',
      'name = "story-studio"',
      `version = "${VERSION}"`,
    ].join('\n'),
    'src-tauri/tauri.conf.json': JSON.stringify({ version: VERSION }),
  };

  await Promise.all(Object.entries(files).map(([relativePath, content]) => (
    relativePath === omit
      ? Promise.resolve()
      : writeFile(path.join(rootDir, relativePath), content, 'utf8')
  )));

  return rootDir;
}

test('accepts the five identical version sources', async (t) => {
  const rootDir = await createFixture(t);
  const sources = await readVersionSources(rootDir);

  assert.deepEqual(sources, matchingSources());
  assert.equal(assertVersionConsistency(sources), VERSION);
});

test('reports a Tauri version divergence with every value read', () => {
  const sources = {
    ...matchingSources(),
    'src-tauri/tauri.conf.json': '7.8.8',
  };

  assert.throws(
    () => assertVersionConsistency(sources),
    (error) => {
      assert.match(error.message, /Version mismatch/);
      assert.match(error.message, /package\.json: 7\.8\.9/);
      assert.match(error.message, /src-tauri\/tauri\.conf\.json: 7\.8\.8/);
      return true;
    },
  );
});

test('reports a Cargo.lock version divergence', () => {
  const sources = {
    ...matchingSources(),
    'src-tauri/Cargo.lock (story-studio)': '7.8.7',
  };

  assert.throws(
    () => assertVersionConsistency(sources),
    /src-tauri\/Cargo\.lock \(story-studio\): 7\.8\.7/,
  );
});

test('fails explicitly when a source file is absent', async (t) => {
  const rootDir = await createFixture(t, {
    omit: 'src-tauri/tauri.conf.json',
  });

  await assert.rejects(
    () => readVersionSources(rootDir),
    /Unable to read src-tauri\/tauri\.conf\.json/,
  );
});
