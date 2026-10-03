// Le rangement du graphe, partagé par le bouton de la colonne et par le
// clavier.
//
// Il vivait dans le bouton : le raccourci ne pouvait ni savoir qu'un rangement
// était déjà en cours, ni dire qu'il avait été refusé. Ces essais tiennent
// l'état commun — un seul rangement à la fois, un refus annoncé, et rien quand
// l'édition est suspendue.

import { runner } from './reactHookDriver.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleView } from './advancedViewFixtures.mjs';

const { buildGraphIndex } = await import('../src/store/advancedGraphView/graphViewModel.js');
const { ARRANGEMENT_REFUSED, useGraphArrangement } = await import('../src/components/AdvancedWorkspace/useGraphArrangement.js');

function mount(options) {
  const hook = runner(() => useGraphArrangement(options));
  return { render: () => hook.render() };
}

test('un rangement appliqué envoie les positions du parcours', async () => {
  const applied = [];
  const arrangement = mount({
    index: buildGraphIndex(sampleView()),
    applyLayout: async (entries) => { applied.push(entries); return true; },
  });
  assert.equal(await arrangement.render().arrange(), true);
  assert.equal(applied.length, 1);
  assert.ok(applied[0].length > 0);
  assert.ok(applied[0].every((entry) => typeof entry.path === 'string'
    && Number.isFinite(entry.x) && Number.isFinite(entry.y)));
  const after = arrangement.render();
  assert.equal(after.busy, false);
  assert.equal(after.failure, null);
});

test('un seul rangement à la fois, quel que soit le déclencheur', async () => {
  let release;
  const calls = [];
  const arrangement = mount({
    index: buildGraphIndex(sampleView()),
    applyLayout: (entries) => {
      calls.push(entries);
      return new Promise((resolve) => { release = () => resolve(true); });
    },
  });
  const first = arrangement.render().arrange();
  // Le bouton et la touche arrivent dans le même tour : le second ne part pas.
  assert.equal(await arrangement.render().arrange(), false);
  assert.equal(calls.length, 1);
  assert.equal(arrangement.render().busy, true);
  release();
  assert.equal(await first, true);
  assert.equal(arrangement.render().busy, false);
});

test('un refus est annoncé, et le document reste intact', async () => {
  const arrangement = mount({
    index: buildGraphIndex(sampleView()),
    applyLayout: async () => false,
  });
  assert.equal(await arrangement.render().arrange(), false);
  assert.equal(arrangement.render().failure, ARRANGEMENT_REFUSED);
});

test('pendant un geste en cours, ni le bouton ni la touche ne rangent', async () => {
  const calls = [];
  const arrangement = mount({
    index: buildGraphIndex(sampleView()),
    applyLayout: async (entries) => { calls.push(entries); return true; },
    disabled: true,
  });
  const state = arrangement.render();
  assert.equal(state.disabled, true);
  assert.equal(await state.arrange(), false);
  assert.deepEqual(calls, []);
});
