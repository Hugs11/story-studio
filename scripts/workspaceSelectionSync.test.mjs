import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getPendingInternalSelectedId,
  resolveWorkspaceSelectionSync,
} from '../src/workspace/selectionSync.js';

function sync({
  selectedId,
  selectedIds,
  pendingInternalSelectedId = null,
}) {
  return resolveWorkspaceSelectionSync({
    selectedId,
    selectedIds,
    pendingInternalSelectedId,
  });
}

test('un changement interne attendu preserve la multi-selection et consomme l attente', () => {
  const selectedIds = new Set(['story-a', 'story-b']);
  const result = sync({
    selectedId: 'story-b',
    selectedIds,
    pendingInternalSelectedId: 'story-b',
  });

  assert.equal(result.selectedIds, selectedIds);
  assert.equal(result.pendingInternalSelectedId, null);
  assert.equal(result.preserveSelection, true);
});

test('retirer en Ctrl un noeud non actif ne cree aucune attente', () => {
  assert.equal(getPendingInternalSelectedId({
    currentSelectedId: 'story-a',
    nextSelectedId: null,
  }), null);
});

test('une selection externe apres le retrait Ctrl devient un singleton', () => {
  const result = sync({
    selectedId: 'story-c',
    selectedIds: new Set(['story-a']),
  });

  assert.deepEqual([...result.selectedIds], ['story-c']);
  assert.equal(result.pendingInternalSelectedId, null);
  assert.equal(result.preserveSelection, false);
});

test('un clic interne sur l id deja actif ne laisse aucune attente', () => {
  assert.equal(getPendingInternalSelectedId({
    currentSelectedId: 'story-a',
    nextSelectedId: 'story-a',
  }), null);
});

test('une attente differente est annulee au profit du singleton externe', () => {
  const result = sync({
    selectedId: 'story-c',
    selectedIds: new Set(['story-a', 'story-b']),
    pendingInternalSelectedId: 'story-b',
  });

  assert.deepEqual([...result.selectedIds], ['story-c']);
  assert.equal(result.pendingInternalSelectedId, null);
  assert.equal(result.preserveSelection, false);
});

test('une attente ne preserve pas une selection qui ne contient pas l id actif', () => {
  const result = sync({
    selectedId: 'story-b',
    selectedIds: new Set(['story-a']),
    pendingInternalSelectedId: 'story-b',
  });

  assert.deepEqual([...result.selectedIds], ['story-b']);
  assert.equal(result.pendingInternalSelectedId, null);
  assert.equal(result.preserveSelection, false);
});

test('root et le message de fin restent des singletons externes valides', () => {
  const rootResult = sync({
    selectedId: 'root',
    selectedIds: new Set(['story-a', 'story-b']),
  });
  const endResult = sync({
    selectedId: 'end-node',
    selectedIds: rootResult.selectedIds,
  });

  assert.deepEqual([...rootResult.selectedIds], ['root']);
  assert.deepEqual([...endResult.selectedIds], ['end-node']);
});

test('deux changements externes successifs ne reutilisent aucune attente', () => {
  const first = sync({
    selectedId: 'story-b',
    selectedIds: new Set(['story-a']),
  });
  const second = sync({
    selectedId: 'story-c',
    selectedIds: first.selectedIds,
    pendingInternalSelectedId: first.pendingInternalSelectedId,
  });

  assert.deepEqual([...first.selectedIds], ['story-b']);
  assert.deepEqual([...second.selectedIds], ['story-c']);
  assert.equal(second.pendingInternalSelectedId, null);
});
