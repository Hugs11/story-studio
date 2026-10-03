import test from 'node:test';
import assert from 'node:assert/strict';
import { audioChecks, matchAudio } from './audio-oracles.mjs';

const source = { name: 'chaud', content: 8.5, lufs: -9, contentLufs: -9,
  truePeak: 0, samplePeak: 0, leading: 0.2, trailing: 0.2 };
const off = { harmonize: false, silence: 'Ne rien faire' };
const adjust = { harmonize: true, silence: 'Ajuster' };
const accepted = checks => Object.values(checks).every(Boolean);

test('oracles rejettent gain, limiteur, mauvais bords et contenu tronqué quand tout est coupé', () => {
  assert.equal(accepted(audioChecks(source, source, off)), true);
  for (const mutation of [
    { contentLufs: -14, lufs: -14 }, { samplePeak: -2 }, { truePeak: -2 },
    { leading: 0.7 }, { trailing: 2.3 }, { content: 8.1 }, { contentLufs: NaN },
  ]) assert.equal(accepted(audioChecks({ ...source, ...mutation }, source, off)), false, JSON.stringify(mutation));
});

test('harmonisation rejette source chaude brute et sortie qui dépasse le plafond MP3', () => {
  const output = { ...source, leading: 0.7, trailing: 2.3, lufs: -14, contentLufs: -14, samplePeak: -2, truePeak: -1 };
  assert.equal(accepted(audioChecks(output, source, adjust)), true);
  assert.equal(accepted(audioChecks(source, source, adjust)), false);
  assert.equal(accepted(audioChecks({ ...output, truePeak: 0 }, source, adjust)), false);
  const weak = { ...source, name: 'faible', contentLufs: -30, lufs: -30 };
  assert.equal(audioChecks(weak, weak, adjust).remonte, false);
  const deadband = { ...source, name: 'bande-morte', contentLufs: -13.5, lufs: -13.5 };
  assert.equal(audioChecks({ ...output, contentLufs: -14.5 }, deadband, adjust).niveauInchange, false);
});

test('Ajouter exige les durées source plus les cibles et distingue Ajuster', () => {
  const output = { ...source, leading: 0.9, trailing: 2.5 };
  assert.equal(accepted(audioChecks(output, source, { ...off, silence: 'Ajouter' })), true);
  assert.equal(accepted(audioChecks({ ...output, leading: 0.7, trailing: 2.3 }, source, { ...off, silence: 'Ajouter' })), false);
});

test('rattachement par contenu rejette absence, doublon, durée inconnue et ambiguïté', () => {
  assert.deepEqual(matchAudio([source], [source]), { chaud: source });
  assert.throws(() => matchAudio([], [source]), /quatre sources/);
  assert.throws(() => matchAudio([source, source], [source]), /dupliquée/);
  assert.throws(() => matchAudio([{ ...source, content: 4 }], [source]), /ambigu/);
  assert.throws(() => matchAudio([source], [source, { ...source, name: 'autre' }]), /ambigu/);
});
