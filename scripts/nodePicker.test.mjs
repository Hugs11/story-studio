// Le sélecteur de nœud : quand il choisit le choix d'une liste, l'Écran
// d'entrée n'y figure pas — il n'est jamais une destination.

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import { presence, sampleView, stage } from './advancedViewFixtures.mjs';

const { mountSurface } = await import('./chromeBench.mjs');
const { NodePicker } = await import('../src/components/AdvancedWorkspace/NodePicker.jsx');

function index() {
  const view = sampleView();
  view.stages = [
    stage('racine', { name: presence('Racine'), squareOne: presence(true) }),
    stage('foret', { name: presence('Forêt') }),
  ];
  view.actions = [];
  view.edges = [];
  return buildGraphIndex(view);
}

const { Select } = await import('../src/components/common/Select.jsx');

const mount = (props) => mountSurface(React.createElement(NodePicker, {
  index: index(), kind: 'stage', value: null, onChange: () => {}, id: 'essai', ...props,
}));
// Les options d'une liste de l'app n'existent qu'ouverte : on lit les libellés que le sélecteur lui donne.
const labels = (props) => mount(props).elements.find((element) => element.type === Select).props.options.map((option) => option.label).join('\n');

test('le choix d’une liste ne propose pas l’Écran d’entrée', () => {
  const forChoice = labels({ forChoice: true });
  assert.doesNotMatch(forChoice, /Racine/);
  assert.match(forChoice, /Forêt/);
  assert.match(labels({}), /Racine/, 'ailleurs, l’Écran d’entrée reste choisissable');
});
