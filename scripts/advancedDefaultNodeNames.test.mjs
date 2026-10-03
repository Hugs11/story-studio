// Le nom d'un nœud créé sans nom dans l'Éditeur graphe.

import test from 'node:test';
import assert from 'node:assert/strict';

import { nextDefaultNodeName, pruneReservedNames } from '../src/store/advancedAuthoring/defaultNodeNames.js';
import { ACTION_KIND, STAGE_KIND } from '../src/store/advancedGraphView/graphViewModel.js';

function indexOf(entries) {
  return {
    entries: entries.map(([kind, name]) => ({
      kind,
      node: { name: name === undefined ? { presence: 'absent' } : { presence: 'value', value: name } },
    })),
  };
}

test('le premier nœud de chaque nature porte le numéro 1', () => {
  assert.equal(nextDefaultNodeName(indexOf([]), STAGE_KIND), 'Écran 1');
  assert.equal(nextDefaultNodeName(null, ACTION_KIND), 'Liste 1');
});

test('le numéro suit le plus grand existant, sans combler les trous', () => {
  const index = indexOf([[STAGE_KIND, 'Écran 1'], [STAGE_KIND, 'Écran 3'], [ACTION_KIND, 'Liste 1']]);
  assert.equal(nextDefaultNodeName(index, STAGE_KIND), 'Écran 4');
  assert.equal(nextDefaultNodeName(index, ACTION_KIND), 'Liste 2');
});

test('seuls les noms exactement numérotés comptent, et par nature', () => {
  const index = indexOf([
    [STAGE_KIND, 'Écran 3 bis'],
    [STAGE_KIND, 'Mon Écran 9'],
    [STAGE_KIND, undefined],
    [ACTION_KIND, 'Écran 7'],
    [STAGE_KIND, 'Liste 5'],
  ]);
  assert.equal(nextDefaultNodeName(index, STAGE_KIND), 'Écran 1');
  assert.equal(nextDefaultNodeName(index, ACTION_KIND), 'Liste 1');
});

// La vue est relue par un aller-retour après chaque geste : une création
// enchaînée dans cette fenêtre lit l'ancien index. Les noms déjà promis
// comptent donc comme pris, jusqu'à ce que l'index les porte.
test('un nom promis à une création en vol n’est pas redonné', () => {
  const index = indexOf([[STAGE_KIND, 'Écran 3']]);
  assert.equal(nextDefaultNodeName(index, STAGE_KIND, ['Écran 4']), 'Écran 5');
  // Seuls les noms de la même nature comptent.
  assert.equal(nextDefaultNodeName(index, ACTION_KIND, ['Écran 4']), 'Liste 1');
});

test('un nom promis est oublié dès que l’index le porte', () => {
  const index = indexOf([[STAGE_KIND, 'Écran 4'], [ACTION_KIND, 'Liste 1']]);
  assert.deepEqual(pruneReservedNames(['Écran 4', 'Écran 5', 'Liste 1'], index), ['Écran 5']);
  assert.deepEqual(pruneReservedNames(null, index), []);
});
