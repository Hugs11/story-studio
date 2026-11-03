import assert from 'node:assert/strict';
import test from 'node:test';
import { luniiStatus } from '../src/store/catalogue/luniiStatus.js';

const dev = (id, patch = {}) => ({ id, name: `Lunii ${id}`, state: 'ready', banner: [], ...patch });

test('aucune Lunii branchée : neutre, sans panneau', () => {
  assert.deepEqual(luniiStatus([], null), { kind: 'none', count: 0, name: null, hasPanel: false });
});
test('une Lunii débranchée ou éjectée compte comme absente, le panneau restant ouvrable', () => {
  assert.equal(luniiStatus([dev('a', { state: 'disconnected' })], 'a').kind, 'none');
  assert.deepEqual(luniiStatus([dev('a', { state: 'ejected' })], 'a'), { kind: 'none', count: 0, name: null, hasPanel: true });
});
test('Lunii lisible : verte, avec son nom', () => {
  assert.deepEqual(luniiStatus([dev('a')], 'a'), { kind: 'ready', count: 1, name: 'Lunii a', hasPanel: true });
  assert.equal(luniiStatus([dev('a', { state: 'detected' })], 'a').kind, 'ready');
});
test('liste abîmée, lecture seule, non prise en charge ou histoires hors liste : à vérifier', () => {
  for (const patch of [{ state: 'damaged' }, { state: 'readOnly' }, { state: 'unsupported' }, { banner: ['orphans'] }, { banner: ['resume'] }, { banner: ['readOnly'] }]) {
    assert.equal(luniiStatus([dev('a', patch)], 'a').kind, 'check', JSON.stringify(patch));
  }
});
test('plusieurs Lunii : le pire état l’emporte, le nom est celui de la Lunii active', () => {
  const status = luniiStatus([dev('a'), dev('b', { state: 'damaged' })], 'a');
  assert.deepEqual(status, { kind: 'check', count: 2, name: 'Lunii a', hasPanel: true });
});
