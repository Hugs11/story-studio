import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const comfyPreferencesSource = await readFile(
  new URL('../src/tabs/OptionsTab/AiImagesSection.jsx', import.meta.url),
  'utf8',
);

test('le délai ComfyUI visible correspond aux 180 secondes du service', () => {
  assert.match(comfyPreferencesSource, /jusqu\\'à 3 minutes/);
  assert.doesNotMatch(comfyPreferencesSource, /jusqu\\'à 60s/);
});
