// Le choix fixe et le tirage au sort sont deux modes d'accès à une liste,
// jamais des éléments mêlés dans un même menu déroulant.

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { action, presence, stage } from './advancedViewFixtures.mjs';
import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';

const { mountSurface } = await import('./chromeBench.mjs');
const { ActionSelectionFields } = await import(
  '../src/components/AdvancedWorkspace/ActionSelectionFields.jsx'
);

const stagePath = (uuid) => `/stageNodes/@uuid=${uuid}#0`;
const actionPath = (id) => `/actionNodes/@id=${id}#0`;

function render(selection) {
  const index = buildGraphIndex({
    viewVersion: 1,
    entry: { status: 'unique', stagePath: stagePath('a'), candidates: [stagePath('a')] },
    counts: { stages: 2, actions: 1, options: 2, edges: 0 },
    stages: [
      stage('a', { name: presence('Écran A') }),
      stage('b', { name: presence('Écran B') }),
    ],
    actions: [action('menu', ['a', 'b'], { name: presence('Menu') })],
    edges: [],
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  });
  return mountSurface(React.createElement(ActionSelectionFields, {
    id: 'selection-test',
    options: index.byPath.get(actionPath('menu')).node.options,
    index,
    selection,
    onChange: () => {},
    disabled: false,
  })).html;
}

test('la sélection fixe nomme son mode et garde les choix dans leur propre liste', () => {
  const html = render('1');
  assert.match(html, /Point de départ dans la liste/);
  assert.match(html, /Toujours le même choix/);
  assert.match(html, /Commence sur/);
  assert.match(html, /2\/2 · Écran B/);
  assert.doesNotMatch(html, /<option value="random"/);
});

test('le mode aléatoire est séparé des choix et utilise l’icône Lucide Dices', () => {
  const html = render('random');
  assert.match(html, /Un choix au hasard, à chaque fois/);
  assert.match(html, /<rect[^>]*width="12"[^>]*height="12"[^>]*x="2"[^>]*y="10"/);
  assert.doesNotMatch(html, /Commence sur/);
  assert.doesNotMatch(html, /<select/);
});
