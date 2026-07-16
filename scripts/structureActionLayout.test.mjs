import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STRUCTURE_ACTIONS_COMPACT_WIDTH,
  partitionStructureActions,
} from '../src/components/structure/structureActionLayout.js';

const actions = [
  { id: 'import', priority: 'primary' },
  { id: 'folder', priority: 'primary' },
  { id: 'podcast', priority: 'secondary' },
  { id: 'simulator', priority: 'secondary' },
];

test('panel compact keeps primary actions direct and moves secondary actions to overflow', () => {
  const layout = partitionStructureActions(actions, {
    variant: 'panel',
    inlineSize: STRUCTURE_ACTIONS_COMPACT_WIDTH - 1,
  });

  assert.deepEqual(layout.directActions.map(({ id }) => id), ['import', 'folder']);
  assert.deepEqual(layout.overflowActions.map(({ id }) => id), ['podcast', 'simulator']);
});

test('wide panel and floating bar keep every action direct', () => {
  const widePanel = partitionStructureActions(actions, {
    variant: 'panel',
    inlineSize: STRUCTURE_ACTIONS_COMPACT_WIDTH,
  });
  const floating = partitionStructureActions(actions, {
    variant: 'floating',
    inlineSize: 100,
  });

  assert.deepEqual(widePanel.directActions, actions);
  assert.deepEqual(widePanel.overflowActions, []);
  assert.deepEqual(floating.directActions, actions);
  assert.deepEqual(floating.overflowActions, []);
});

test('unmeasured panel starts compact to avoid an overflow flash', () => {
  const layout = partitionStructureActions(actions, {
    variant: 'panel',
    inlineSize: null,
  });

  assert.deepEqual(layout.directActions.map(({ id }) => id), ['import', 'folder']);
  assert.deepEqual(layout.overflowActions.map(({ id }) => id), ['podcast', 'simulator']);
});
