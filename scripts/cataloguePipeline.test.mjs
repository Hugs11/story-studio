// Pipeline recherche → filtres → tri : résultat identique quel que soit
// l'ordre d'entrée, compteurs en fiches et exemplaires, exemplaire
// représentatif commun, mesure sur 10 000 fiches synthétiques.

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { representativeExemplar, runPipeline } from '../src/store/catalogue/pipeline.js';
import { normalizeEntries } from '../src/store/catalogue/entryModel.js';
import { card, rawEntry } from './catalogueFixtures.mjs';

const cards = [
  card({ id: 'lune', title: 'La Lune', ageMin: 3, description: 'douce', exemplars: [
    { id: 'l-zip-a', format: 'zip', sources: ['A'], modifiedAt: 10, sizeBytes: 300 },
    { id: 'l-zip-b', format: 'zip', sources: ['B'], modifiedAt: 20, sizeBytes: 900 },
    { id: 'l-proj', format: 'project', sources: ['A'], modifiedAt: 30, sizeBytes: 50 },
  ] }),
  card({ id: 'ours', title: 'L’Ours', ageMin: 6, ageMax: 9, exemplars: [{ id: 'o-zip', format: 'zip', sources: ['B'], modifiedAt: 5, sizeBytes: 100 }] }),
  card({ id: 'chat', title: 'Le Chat', exemplars: [{ id: 'c-7z', format: 'sevenZip', sources: ['A'], modifiedAt: 1, sizeBytes: null }] }),
  card({ id: 'off', title: 'Hors ligne', exemplars: [{ id: 'x', available: false }] }),
];

test('résultat identique quel que soit l’ordre d’entrée', () => {
  const options = { query: 'l', filters: { formats: ['zip', 'sevenZip'] }, sort: { key: 'size', direction: 'desc' } };
  const forward = runPipeline(cards, options);
  const backward = runPipeline([...cards].reverse(), options);
  const shuffled = runPipeline([cards[2], cards[0], cards[3], cards[1]], options);
  assert.deepEqual(backward.ids, forward.ids);
  assert.deepEqual(shuffled.ids, forward.ids);
  assert.deepEqual(forward.ids, ['off', 'lune', 'ours', 'chat']);
});

test('compteurs en fiches et exemplaires correspondants ; hors ligne visibles par défaut', () => {
  const all = runPipeline(cards);
  assert.deepEqual(all.counts, { fiches: 4, exemplaires: 6 });
  const zipA = runPipeline(cards, { filters: { formats: ['zip'], sourceIds: ['A'], availability: 'available' } });
  assert.deepEqual(zipA.ids, ['lune']);
  assert.deepEqual(zipA.counts, { fiches: 1, exemplaires: 1 });
  assert.deepEqual(zipA.matchingExemplars.get('lune'), ['l-zip-a']);
  assert.deepEqual(runPipeline(cards, { filters: { availability: 'all' } }).counts.fiches, 4);
});

test('taille et date prises sur l’exemplaire correspondant aux filtres', () => {
  const zipA = runPipeline(cards, { filters: { formats: ['zip'], sourceIds: ['A'], availability: 'available' } });
  assert.equal(zipA.representatives.get('lune').id, 'l-zip-a');
  const any = runPipeline(cards);
  assert.equal(any.representatives.get('lune').id, 'l-proj', 'le plus récent');
  const bySize = runPipeline(cards, { filters: { formats: ['zip'] }, sort: { key: 'size', direction: 'asc' } });
  assert.deepEqual(bySize.ids, ['ours', 'lune', 'off'], 'Lune triée sur son ZIP le plus récent (900)');
  assert.equal(representativeExemplar([]), null);
});

test('recherche et explications dans le résultat', () => {
  const result = runPipeline(cards, { query: 'douce' });
  assert.deepEqual(result.ids, ['lune']);
  assert.equal(result.explanations.get('lune')[0].field, 'description');
  assert.equal(runPipeline(cards, { query: 'lune' }).explanations.size, 0);
});

test('filtre d’âge dans le pipeline (inconnus visibles par défaut)', () => {
  assert.deepEqual(runPipeline(cards, { filters: { age: { min: 5, max: 8 } } }).ids, ['off', 'ours', 'chat'], 'Hors ligne, L’Ours puis Le Chat');
  assert.deepEqual(runPipeline(cards, { filters: { age: { min: 5, max: 8, hideUnknown: true } } }).ids, ['ours']);
});

function synthetic(count) {
  const formats = ['project', 'zip', 'sevenZip', 'folder'];
  const words = ['lune', 'ours', 'forêt', 'dragon', 'pirate', 'étoile', 'chat', 'mer', 'nuit', 'château'];
  const raws = [];
  for (let index = 0; index < count; index += 1) {
    const exemplars = [];
    for (let copy = 0; copy < 1 + (index % 3); copy += 1) {
      exemplars.push({
        format: formats[(index + copy) % 4], sources: [`S${(index + copy) % 5}`],
        path: `/bibliotheque/${words[index % 10]}/${index}-${copy}.zip`,
        modifiedAt: 1_700_000_000_000 + ((index * 7919 + copy) % 100_000), sizeBytes: (index * 31) % 50_000,
        available: (index + copy) % 17 !== 0,
      });
    }
    raws.push(rawEntry({
      id: `card-${String(index).padStart(5, '0')}`,
      title: `${words[index % 10]} ${words[(index * 3) % 10]} ${index}`,
      description: index % 4 ? `Histoire ${words[(index * 7) % 10]}` : undefined,
      ageMin: index % 5 ? index % 10 : undefined,
      exemplars,
    }));
  }
  return normalizeEntries(raws);
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(ratio * sorted.length) - 1)];
}

test('mesure : pipeline sur 10 000 fiches synthétiques (p95 consigné)', (t) => {
  const data = synthetic(10_000);
  const scenarios = [
    { query: '', sort: { key: 'title' } },
    { query: 'lune', sort: { key: 'title' } },
    { query: 'chateau nuit', filters: { age: { min: 3, max: 6 } }, sort: { key: 'size', direction: 'desc' } },
    { filters: { formats: ['zip'], sourceIds: ['S1', 'S2'] }, sort: { key: 'modifiedAt', direction: 'desc' } },
    { query: 'histoire', filters: { availability: 'all' }, sort: { key: 'age' } },
  ];
  const cold = performance.now();
  runPipeline(data, scenarios[1]);
  const coldMs = performance.now() - cold;
  const durations = [];
  for (let round = 0; round < 8; round += 1) {
    for (const scenario of scenarios) {
      const start = performance.now();
      const result = runPipeline(data, scenario);
      durations.push(performance.now() - start);
      assert.equal(result.ids.length, result.counts.fiches);
    }
  }
  const p95 = percentile(durations, 0.95);
  t.diagnostic(`10 000 fiches : premier passage ${coldMs.toFixed(1)} ms (index de recherche), p95 ${p95.toFixed(1)} ms, médiane ${percentile(durations, 0.5).toFixed(1)} ms sur ${durations.length} exécutions`);
  // Garde-fou large (le budget de 100 ms se mesure sur la machine de référence).
  assert.ok(p95 < 2000, `p95 ${p95} ms`);
});

test('missing files criterion matches the activity count, not unavailable exemplars', () => {
  const missing = { ...card({ id: 'missing', exemplars: [{ available: false, state: 'missing' }] }), offlineReason: 'missing' };
  const folder = card({ id: 'folder', exemplars: [{ available: false, state: 'unavailable' }] });
  const mixed = card({ id: 'mixed', exemplars: [{ available: false, state: 'missing' }, { available: true }] });
  const data = [missing, folder, mixed, ...cards];
  const counted = data.filter(entry => entry.offlineReason === 'missing');
  const result = runPipeline(data, { filters: { missingFilesOnly: true } });
  assert.deepEqual(result.ids, counted.map(entry => entry.id));
  assert.deepEqual(result.counts, { fiches: 1, exemplaires: 1 });
  assert.ok(runPipeline(data, { filters: { availability: 'unavailable' } }).ids.includes('folder'));
  assert.ok(runPipeline(data, { filters: { availability: 'unavailable' } }).ids.includes('mixed'));
  // The same active criterion follows publications, without keeping a stale ID list.
  assert.equal(runPipeline([{ ...missing, offlineReason: 'unavailable' }], { filters: { missingFilesOnly: true } }).counts.fiches, 0);
});
