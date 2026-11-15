import test from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, runSettingsMigrations } from '../src/store/persistentSettings.js';

test('le démarrage retire les anciens résultats IA et conserve les réglages ComfyUI', () => {
  const previousStorage = globalThis.localStorage;
  const settings = JSON.stringify({ serverUrl: 'http://localhost:8188' });
  const values = new Map([
    ['sdJobResults', JSON.stringify([{ status: 'done', resultPaths: ['/ancien/renard.png'] }])],
    [KEYS.SD_SETTINGS, settings],
  ]);
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  try {
    runSettingsMigrations();
    assert.equal(values.has('sdJobResults'), false);
    assert.equal(values.get(KEYS.SD_SETTINGS), settings);
  } finally {
    globalThis.localStorage = previousStorage;
  }
});
