import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RELEASE_NOTES, shouldShowReleaseNotes } from '../src/config/releaseNotes.js';

test('les nouveautés apparaissent à la première ouverture et après une mise à jour', () => {
  assert.equal(shouldShowReleaseNotes('0.9.9', null), true);
  assert.equal(shouldShowReleaseNotes('0.9.9', '0.9.8'), true);
  assert.equal(shouldShowReleaseNotes('0.9.9', '0.9.9'), false);
  assert.equal(shouldShowReleaseNotes('', null), false);
  assert.equal(shouldShowReleaseNotes('0.9.10', '0.9.9'), false);
});

test('la fenêtre annonce la version et la date publiées dans le changelog', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  assert.equal(RELEASE_NOTES.version, manifest.version);
  const release = changelog.match(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/m);
  assert.ok(release, 'entrée datée attendue dans le changelog');
  assert.equal(RELEASE_NOTES.version, release[1]);
  assert.equal(RELEASE_NOTES.date, release[2]);
  assert.equal(new Date(RELEASE_NOTES.date).toISOString().slice(0, 10), RELEASE_NOTES.date);
});
