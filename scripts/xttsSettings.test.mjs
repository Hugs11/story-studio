import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { KEYS } from '../src/store/persistentSettings.js';
import {
  loadXttsSettings,
  PIPER_DEFAULT_LANGUAGE,
  PIPER_DEFAULT_VOICE,
  piperDefaultVoiceForLanguage,
  piperLanguageForVoice,
  saveXttsSettings,
} from '../src/store/xttsSettings.js';

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

test('legacy Piper sentence silence is tolerated but removed in memory', () => {
  globalThis.localStorage.setItem(KEYS.XTTS_SETTINGS, JSON.stringify({
    backend: 'piper',
    piperVoice: 'fr_FR-tom-medium',
    piperSentenceSilence: 0.75,
  }));

  const loaded = loadXttsSettings();

  assert.equal(loaded.piperVoice, 'fr_FR-tom-medium');
  assert.equal(Object.hasOwn(loaded, 'piperSentenceSilence'), false);
});

test('Piper sentence silence is never persisted again', () => {
  saveXttsSettings({
    backend: 'piper',
    piperVoice: PIPER_DEFAULT_VOICE,
    piperSpeed: 1.25,
    piperSentenceSilence: 0.4,
  });

  const saved = JSON.parse(globalThis.localStorage.getItem(KEYS.XTTS_SETTINGS));
  assert.equal(saved.piperSpeed, 1.25);
  assert.equal(Object.hasOwn(saved, 'piperSentenceSilence'), false);
});

test('Piper defaults to French and migrates the removed Gilles voice to Siwis', () => {
  assert.equal(loadXttsSettings().piperLanguage, PIPER_DEFAULT_LANGUAGE);

  globalThis.localStorage.setItem(KEYS.XTTS_SETTINGS, JSON.stringify({
    backend: 'piper',
    piperVoice: 'fr_FR-gilles-low',
  }));

  const migrated = loadXttsSettings();
  assert.equal(migrated.piperLanguage, 'fr_FR');
  assert.equal(migrated.piperVoice, PIPER_DEFAULT_VOICE);
});

test('Piper catalog helpers resolve each language standard and a voice language', () => {
  const voices = [
    { id: 'en_GB-alba-medium', language: 'en_GB', isDefault: false },
    { id: 'en_GB-jenny_dioco-medium', language: 'en_GB', isDefault: true },
  ];

  assert.equal(piperDefaultVoiceForLanguage(voices, 'en_GB'), 'en_GB-jenny_dioco-medium');
  assert.equal(piperDefaultVoiceForLanguage([], 'it_IT'), 'it_IT-serena-medium');
  assert.equal(piperLanguageForVoice(voices, 'en_GB-alba-medium'), 'en_GB');
  assert.equal(piperLanguageForVoice(voices, 'missing'), 'fr_FR');
});
