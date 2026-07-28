import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertSafeArchiveEntries,
  PIPER_TARGETS,
} from './build-piper-runtime.mjs';
import {
  ESPEAK_COMMIT,
  ONNXRUNTIME_VERSION,
  PIPER_BUILD_INPUTS,
  PIPER_COMMIT,
  PIPER_VERSION,
  PIPER_VOICES_VERSION,
  selectPiperTarget,
} from './piper-runtime-manifest.mjs';
import { expectedPiperRootEntries, sha256 } from './piper-runtime.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

test('Piper manifest pins the source and all build-only inputs', () => {
  assert.equal(PIPER_VERSION, '1.6.0');
  assert.equal(PIPER_COMMIT, 'f04d52c5528ac7cf2d73757f57990ff490f75005');
  assert.equal(ESPEAK_COMMIT, '212928b394a96e8fd2096616bfd54e17845c48f6');
  assert.equal(ONNXRUNTIME_VERSION, '1.22.0');
  assert.equal(PIPER_VOICES_VERSION, 'v1.0.0');

  for (const spec of Object.values(PIPER_BUILD_INPUTS)) {
    assert.match(spec.url, /^https:\/\//);
    assert.doesNotMatch(spec.url, /\/latest(?:\/|$)/i);
    assert.match(spec.sha256, SHA256_PATTERN);
    assert.ok(spec.maxBytes > 0);
  }
  assert.match(PIPER_BUILD_INPUTS.piper.url, /\/v1\.6\.0$/);
  assert.match(PIPER_BUILD_INPUTS.espeak.url, new RegExp(`${ESPEAK_COMMIT}$`));
  assert.match(PIPER_BUILD_INPUTS.testModel.url, /\/v1\.0\.0\//);
});

test('Piper runtime targets cover only the supported desktop pairs', () => {
  assert.deepEqual(
    Object.keys(PIPER_TARGETS).sort(),
    ['darwin-arm64', 'linux-x64', 'win32-x64'],
  );
  assert.deepEqual(PIPER_TARGETS['win32-x64'].architectures, ['x86_64']);
  assert.deepEqual(PIPER_TARGETS['linux-x64'].architectures, ['x86_64']);
  assert.deepEqual(PIPER_TARGETS['darwin-arm64'].architectures, ['aarch64']);

  for (const target of Object.values(PIPER_TARGETS)) {
    assert.match(target.onnxruntime.url, /^https:\/\//);
    assert.doesNotMatch(target.onnxruntime.url, /latest/i);
    assert.match(target.onnxruntime.sha256, SHA256_PATTERN);
    assert.ok(target.runtimeFiles.some(({ output }) => output === target.executable));
    const outputs = target.runtimeFiles.map(({ output }) => output);
    assert.equal(new Set(outputs).size, outputs.length);
    assert.deepEqual(
      expectedPiperRootEntries(target),
      [...outputs, 'espeak-ng-data', 'licenses', 'piper-runtime.json'].sort(),
    );
  }
});

test('Piper target selection rejects unsupported architectures', () => {
  assert.equal(
    selectPiperTarget('darwin', 'arm64').target.platformName,
    'macos-aarch64',
  );
  assert.throws(
    () => selectPiperTarget('darwin', 'x64'),
    /Unsupported Piper target/,
  );
  assert.throws(
    () => selectPiperTarget('linux', 'arm64'),
    /Unsupported Piper target/,
  );
});

test('Piper source archive inspection rejects traversal and unexpected roots', () => {
  assert.doesNotThrow(() => assertSafeArchiveEntries([
    'piper/',
    'piper/libpiper/',
    'piper/libpiper/CMakeLists.txt',
  ], 'piper'));
  assert.throws(
    () => assertSafeArchiveEntries(['piper/', '../outside'], 'piper'),
    /unsafe/,
  );
  assert.throws(
    () => assertSafeArchiveEntries(['another-root/file'], 'piper'),
    /unsafe/,
  );
  assert.throws(
    () => assertSafeArchiveEntries(['piper\\windows-path'], 'piper'),
    /unsafe/,
  );
});

test('Story Studio Piper patch contains offline inputs and audio normalization tests', async () => {
  const patch = await readFile(
    new URL('./patches/piper-1.6.0-story-studio.patch', import.meta.url),
  );
  const text = patch.toString('utf8');
  assert.match(sha256(patch), SHA256_PATTERN);
  assert.match(text, /PIPER_ESPEAK_SOURCE_DIR/);
  assert.match(text, /PIPER_TEST_MODEL_DIR/);
  assert.match(text, /normalizeAudioSamples/);
  assert.match(text, /QuasiSilenceBecomesSilence/);
  assert.match(text, /NonFiniteSamplesBecomeSilence/);
});

test('public notices cover every distributed Piper build input', async () => {
  const notices = await readFile(
    new URL('../THIRD_PARTY_NOTICES.md', import.meta.url),
    'utf8',
  );
  for (const marker of [
    PIPER_BUILD_INPUTS.piper.url,
    PIPER_BUILD_INPUTS.piper.sha256,
    PIPER_BUILD_INPUTS.espeak.url,
    PIPER_BUILD_INPUTS.espeak.sha256,
    PIPER_BUILD_INPUTS.sonic.url,
    PIPER_BUILD_INPUTS.sonic.sha256,
    'scripts/patches/piper-1.6.0-story-studio.patch',
  ]) {
    assert.ok(notices.includes(marker), `missing notice marker: ${marker}`);
  }
  for (const target of Object.values(PIPER_TARGETS)) {
    assert.ok(notices.includes(target.onnxruntime.url));
    assert.ok(notices.includes(target.onnxruntime.sha256));
  }
});
