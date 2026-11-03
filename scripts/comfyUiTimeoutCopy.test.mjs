import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const comfyPreferencesSource = await readFile(
  new URL('../src/tabs/OptionsTab/AiImagesSection.jsx', import.meta.url),
  'utf8',
);

const settingsFr = JSON.parse(await readFile(new URL('../src/locales/fr/settings.json', import.meta.url), 'utf8'));

test('le délai ComfyUI visible correspond aux 180 secondes du service', () => {
  assert.match(comfyPreferencesSource, /key: 'settings:images.start.progress'/);
  assert.equal(settingsFr['images.start.progress'], 'Démarrage de ComfyUI en cours… (peut prendre jusqu’à 3 minutes)');
  assert.doesNotMatch(settingsFr['images.start.progress'], /jusqu['’]à 60 ?s/);
});
