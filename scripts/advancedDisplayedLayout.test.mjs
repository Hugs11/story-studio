// À l'export, la disposition affichée devient la disposition d'auteur.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  displayedLayoutGestures,
  displayedLayoutToPromote,
  promoteDisplayedLayout,
} from '../src/store/advancedExport/displayedLayout.js';

const view = () => ({
  stages: [
    { uuid: 's-auteur', uniqueId: true, layout: { x: 10, y: 20, source: 'authored' } },
    { uuid: 's-editeur', uniqueId: true, layout: { x: 214.5, y: 181.4, source: 'editor-position' } },
    { uuid: 's-secours', uniqueId: true, layout: { x: 0, y: 0, source: 'fallback' } },
    { uuid: 's-double', uniqueId: false, layout: { x: 5, y: 5, source: 'fallback' } },
  ],
  actions: [
    { id: 'a-loin', uniqueId: true, layout: { x: 90_000, y: -90_000, source: 'editor-position' } },
  ],
});

test('seules les positions affichées qui ne sont pas d’auteur sont promues, en entiers bornés', () => {
  assert.deepEqual(displayedLayoutToPromote(view()), [
    { node: { kind: 'stage', id: 's-editeur' }, position: { x: 215, y: 181 } },
    { node: { kind: 'stage', id: 's-secours' }, position: { x: 0, y: 0 } },
    { node: { kind: 'action', id: 'a-loin' }, position: { x: 32_767, y: -32_768 } },
  ]);
});

test('un pack déjà entièrement positionné ne produit aucun geste', () => {
  assert.deepEqual(displayedLayoutGestures({ stages: [view().stages[0]], actions: [] }), []);
});

test('la promotion enchaîne les deux gestes hors historique et rend le projet promu', async () => {
  const sent = [];
  const project = await promoteDisplayedLayout({
    readProject: () => 'avant',
    readGraphView: async () => view(),
    runGesture: async (gesture, options) => {
      sent.push([gesture.gesture, options.history]);
      return { status: 'applied', project: `après ${gesture.gesture}` };
    },
    applied: 'applied',
  });
  assert.deepEqual(sent, [['apply-view-layout', false], ['apply-layout-to-authoring', false]]);
  assert.equal(project, 'après apply-layout-to-authoring');
});

test('un refus n’empêche pas l’export : rien n’est rendu, et le journal le dit', async () => {
  const warnings = [];
  const project = await promoteDisplayedLayout({
    readProject: () => 'avant',
    readGraphView: async () => view(),
    runGesture: async () => ({ status: 'refused' }),
    applied: 'applied',
    warn: (message) => warnings.push(message),
  });
  assert.equal(project, null);
  assert.equal(warnings.length, 1);
});
