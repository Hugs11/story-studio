import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionActions, selectionPanelActions } from '../src/store/catalogue/selectionActions.js';

const compose = (targets) => {
  const ids = targets.map(card => card.id);
  return selectionPanelActions(targets, selectionActions(ids, targets, ids, {}).actions, 'idle', false);
};

// Décision du 24 oct. (0.9.10) et brief #20 : « Retirer du catalogue » ne vise que des fiches
// introuvables. « Fichiers présents ou disque débranché : rien. »
test('une sélection de packs présents ne propose pas « Retirer du catalogue »', () => {
  const present = [{ id: 'a', available: true, offlineReason: null }, { id: 'b', available: true, offlineReason: null }];
  assert.ok(!compose(present).some(action => action.id === 'removeFromCatalogue'),
    'des packs présents perdraient favoris, corrections et étiquettes, puis reviendraient au scan suivant');
});

test('une sélection de packs sur un disque débranché ne propose pas « Retirer du catalogue »', () => {
  const unplugged = [{ id: 'a', available: false, offlineReason: 'unavailable' }, { id: 'b', available: false, offlineReason: 'unavailable' }];
  assert.ok(!compose(unplugged).some(action => action.id === 'removeFromCatalogue'));
});
