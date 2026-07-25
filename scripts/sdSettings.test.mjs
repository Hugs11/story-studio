import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { KEYS } from '../src/store/persistentSettings.js';
import { loadSdSettings, saveSdSettings } from '../src/store/sdSettings.js';

function createLocalStorageMock() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

beforeEach(() => {
  globalThis.localStorage = createLocalStorageMock();
});

test('loadSdSettings migrates batPath to launcherPath in memory', () => {
  globalThis.localStorage.setItem(KEYS.SD_SETTINGS, JSON.stringify({
    serverUrl: 'http://127.0.0.1:8188',
    autoStart: true,
    batPath: 'C:\\Comfy UI\\run_nvidia_gpu.bat',
  }));

  const loaded = loadSdSettings();

  assert.equal(loaded.launcherPath, 'C:\\Comfy UI\\run_nvidia_gpu.bat');
  assert.equal(Object.hasOwn(loaded, 'batPath'), false);
});

test('portable launcherPath takes precedence and is the only name saved', () => {
  globalThis.localStorage.setItem(KEYS.SD_SETTINGS, JSON.stringify({
    launcherPath: '/opt/Comfy UI/start comfy.sh',
    batPath: 'C:\\legacy.bat',
  }));

  const loaded = loadSdSettings();
  saveSdSettings({ ...loaded, batPath: 'C:\\should-not-return.bat' });
  const saved = JSON.parse(globalThis.localStorage.getItem(KEYS.SD_SETTINGS));

  assert.equal(loaded.launcherPath, '/opt/Comfy UI/start comfy.sh');
  assert.equal(saved.launcherPath, '/opt/Comfy UI/start comfy.sh');
  assert.equal(Object.hasOwn(saved, 'batPath'), false);
});

test('loadSdSettings returns portable defaults for invalid storage', () => {
  globalThis.localStorage.setItem(KEYS.SD_SETTINGS, '{invalid');

  assert.deepEqual(loadSdSettings(), {
    serverUrl: 'http://127.0.0.1:8188',
    autoStart: false,
    launcherPath: '',
    aiImageGen: false,
  });
});
