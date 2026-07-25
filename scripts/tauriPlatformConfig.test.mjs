import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
}

function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const merged = target && typeof target === 'object' && !Array.isArray(target)
    ? { ...target }
    : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete merged[key];
    else merged[key] = mergePatch(merged[key], value);
  }
  return merged;
}

test('Tauri platform configs resolve with replacement arrays and isolated tool resources', async () => {
  const common = await readJson('../src-tauri/tauri.conf.json');
  const windows = mergePatch(common, await readJson('../src-tauri/tauri.windows.conf.json'));
  const linux = mergePatch(common, await readJson('../src-tauri/tauri.linux.conf.json'));

  assert.deepEqual(windows.bundle.targets, ['nsis', 'msi']);
  assert.deepEqual(linux.bundle.targets, ['appimage', 'deb', 'rpm']);
  assert.equal(windows.bundle.resources['tools/ffmpeg.exe'], 'tools/ffmpeg.exe');
  assert.equal(windows.bundle.resources['tools/7z.exe'], 'tools/7z.exe');
  assert.equal(linux.bundle.resources['tools/ffmpeg.exe'], undefined);
  assert.equal(linux.bundle.resources['tools/7z.exe'], undefined);
  assert.equal(linux.bundle.resources['../LICENSE'], 'LICENSE');
  assert.equal(linux.app.windows[0].decorations, false);
});

test('Tauri filesystem scopes are split by platform and preserve removable media access', async () => {
  const common = await readJson('../src-tauri/capabilities/default.json');
  const windows = await readJson('../src-tauri/capabilities/filesystem-windows.json');
  const linux = await readJson('../src-tauri/capabilities/filesystem-linux.json');

  assert.equal(common.permissions.some((permission) => typeof permission === 'object'), false);
  assert.deepEqual(windows.platforms, ['windows']);
  assert.deepEqual(linux.platforms, ['linux']);

  for (const permission of linux.permissions) {
    const denied = new Set(permission.deny.map(({ path }) => path));
    for (const systemPath of ['/boot/**', '/dev/**', '/etc/**', '/proc/**', '/root/**', '/sys/**', '/usr/**']) {
      assert.equal(denied.has(systemPath), true, `${permission.identifier} must deny ${systemPath}`);
    }
    assert.equal(denied.has('/run'), true);
    assert.equal(denied.has('/run/**'), false, '/run/media must stay available for removable media');
    assert.equal(permission.allow.some(({ path }) => path === '**'), true);
  }
});
