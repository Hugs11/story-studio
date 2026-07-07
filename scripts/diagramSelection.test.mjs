import test from 'node:test';
import assert from 'node:assert/strict';

import { toggleDiagramSelection } from '../src/components/CentralPanel/diagram/diagramSelection.js';

test('toggleDiagramSelection ajoute un noeud a la multi et le rend actif', () => {
  const { next, nextSelectedId } = toggleDiagramSelection({
    id: 'story-b',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a']),
  });

  assert.deepEqual([...next].sort(), ['story-a', 'story-b']);
  assert.equal(nextSelectedId, 'story-b');
});

test('Ctrl+clic retire le noeud actif d\'une multi et bascule sur un id encore selectionne', () => {
  const { next, nextSelectedId } = toggleDiagramSelection({
    id: 'story-a',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a', 'story-b']),
  });

  assert.deepEqual([...next], ['story-b']);
  assert.equal(nextSelectedId, 'story-b');
  assert.ok(next.has(nextSelectedId), 'l\'id actif doit rester dans la selection');
});

test('Ctrl+clic retire un noeud non actif : l\'element actif reste inchange', () => {
  const { next, nextSelectedId } = toggleDiagramSelection({
    id: 'story-b',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a', 'story-b', 'story-c']),
  });

  assert.deepEqual([...next].sort(), ['story-a', 'story-c']);
  assert.equal(nextSelectedId, 'story-a');
});

test('Ctrl+clic sur le seul noeud selectionne le garde selectionne (jamais vide)', () => {
  const { next, nextSelectedId } = toggleDiagramSelection({
    id: 'story-a',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a']),
  });

  assert.deepEqual([...next], ['story-a']);
  assert.equal(nextSelectedId, 'story-a');
});

test('toggleDiagramSelection ignore END_NODE_ID venu d\'une multi arbre et restaure l\'invariant', () => {
  // Multi issue de l'arbre contenant le message de fin, actif = end-node.
  const { next, nextSelectedId } = toggleDiagramSelection({
    id: 'story-a',
    selectedId: 'end-node',
    selectedIds: new Set(['end-node', 'story-a', 'story-b']),
  });

  assert.deepEqual([...next].sort(), ['story-b']);
  assert.ok(!next.has('end-node'), 'end-node ne participe pas a la multi diagramme');
  assert.ok(next.has(nextSelectedId), 'l\'id actif renvoye appartient a la selection');
  assert.equal(nextSelectedId, 'story-b');
});
