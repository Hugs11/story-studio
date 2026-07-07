import test from 'node:test';
import assert from 'node:assert/strict';

import {
  rangeTreeSelection,
  toggleTreeSelection,
} from '../src/components/TreePanel/useTreeSelection.js';

test('toggleTreeSelection adds root to an existing selection', () => {
  const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({
    id: 'root',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a']),
  });

  assert.deepEqual([...next].sort(), ['root', 'story-a']);
  assert.equal(nextSelectedId, 'root');
  assert.equal(nextAnchorId, 'root');
});

test('toggleTreeSelection adds a story to an existing root selection', () => {
  const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({
    id: 'story-a',
    selectedId: 'root',
    selectedIds: new Set(['root']),
  });

  assert.deepEqual([...next].sort(), ['root', 'story-a']);
  assert.equal(nextSelectedId, 'story-a');
  assert.equal(nextAnchorId, 'story-a');
});

test('toggleTreeSelection keeps the active singleton selected and active', () => {
  const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({
    id: 'story-a',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a']),
  });

  assert.deepEqual([...next], ['story-a']);
  assert.equal(nextSelectedId, 'story-a');
  assert.equal(nextAnchorId, null);
  assert.ok(next.has(nextSelectedId));
});

test('toggleTreeSelection adds end node to an existing selection', () => {
  const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({
    id: 'end-node',
    selectedId: 'story-a',
    selectedIds: new Set(['story-a']),
  });

  assert.deepEqual([...next].sort(), ['end-node', 'story-a']);
  assert.equal(nextSelectedId, 'end-node');
  assert.equal(nextAnchorId, 'end-node');
});

test('toggleTreeSelection keeps end node when adding another node afterwards', () => {
  const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({
    id: 'story-a',
    selectedId: 'end-node',
    selectedIds: new Set(['end-node']),
  });

  assert.deepEqual([...next].sort(), ['end-node', 'story-a']);
  assert.equal(nextSelectedId, 'story-a');
  assert.equal(nextAnchorId, 'story-a');
});

test('rangeTreeSelection includes root when the range crosses root', () => {
  const flatNodes = [
    { id: 'root' },
    { id: 'menu-a' },
    { id: 'story-a' },
  ];
  const flatNodeIndexById = new Map(flatNodes.map((node, index) => [node.id, index]));

  const next = rangeTreeSelection({
    id: 'root',
    anchorId: 'story-a',
    selectedIds: new Set(['story-a']),
    flatNodes,
    flatNodeIndexById,
  });

  assert.deepEqual([...next].sort(), ['menu-a', 'root', 'story-a']);
});

test('rangeTreeSelection can include end node', () => {
  const flatNodes = [
    { id: 'root' },
    { id: 'story-a' },
    { id: 'end-node' },
  ];
  const flatNodeIndexById = new Map(flatNodes.map((node, index) => [node.id, index]));

  const next = rangeTreeSelection({
    id: 'end-node',
    anchorId: 'story-a',
    selectedIds: new Set(['story-a']),
    flatNodes,
    flatNodeIndexById,
  });

  assert.deepEqual([...next].sort(), ['end-node', 'story-a']);
});
