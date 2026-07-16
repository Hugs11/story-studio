import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProjectIndex } from '../src/store/projectModel/index.js';
import { moveEntryToContainer } from '../src/store/projectModel/operations.js';
import {
  TREE_COLOR_PALETTE,
  canMoveEntryToContainer,
  containsMenu,
  countDescendants,
  filterTopLevelSelectedIds,
  hasSelectedAncestor,
  resolveDropContainerId,
  resolveDropTargetForNode,
  wouldCreateMenuCycle,
} from '../src/components/tree/treeOperations.js';

const project = {
  rootEntries: [
    {
      id: 'menu-a',
      type: 'menu',
      name: 'Menu A',
      children: [
        {
          id: 'menu-b',
          type: 'menu',
          name: 'Menu B',
          children: [
            { id: 'story-1', type: 'story', name: 'Story 1' },
          ],
        },
      ],
    },
    { id: 'menu-c', type: 'menu', name: 'Menu C', children: [] },
  ],
};

test('containsMenu detects nested menu descendants', () => {
  assert.equal(containsMenu(project.rootEntries[0], 'menu-b'), true);
  assert.equal(containsMenu(project.rootEntries[0], 'menu-c'), false);
});

test('wouldCreateMenuCycle blocks moving a menu into its descendant', () => {
  const index = buildProjectIndex(project);
  assert.equal(wouldCreateMenuCycle(project.rootEntries[0], 'menu-b', index), true);
  assert.equal(wouldCreateMenuCycle(project.rootEntries[0], 'menu-c', index), false);
});

test('canMoveEntryToContainer shares the same tree move guard for panels', () => {
  const index = buildProjectIndex(project);
  assert.equal(canMoveEntryToContainer(project, index, 'menu-a', 'menu-b'), false);
  assert.equal(canMoveEntryToContainer(project, index, 'story-1', 'menu-c'), true);
});

test('TREE_COLOR_PALETTE exposes 7 distinct colors', () => {
  assert.equal(TREE_COLOR_PALETTE.length, 7);
  assert.equal(new Set(TREE_COLOR_PALETTE).size, 7);
});

test('countDescendants returns 0 for leaves and counts recursively for menus', () => {
  assert.equal(countDescendants({ type: 'story' }), 0);
  assert.equal(countDescendants({ type: 'menu', children: [] }), 0);
  assert.equal(countDescendants(project.rootEntries[0]), 2); // menu-b + story-1
});

test('hasSelectedAncestor walks parent chain until it hits the candidate set', () => {
  const parentMap = new Map([
    ['story-1', 'menu-b'],
    ['menu-b', 'menu-a'],
    ['menu-a', null],
  ]);
  const getParentId = (id) => parentMap.get(id) ?? null;
  assert.equal(hasSelectedAncestor('story-1', new Set(['menu-a']), getParentId), true);
  assert.equal(hasSelectedAncestor('story-1', new Set(['menu-c']), getParentId), false);
  assert.equal(hasSelectedAncestor('menu-a', new Set(['menu-a']), getParentId), false); // self n'est pas un ancetre
});

test('filterTopLevelSelectedIds removes a selected child when its parent is selected', () => {
  const getParentId = (id) => new Map([
    ['child', 'parent'],
    ['parent', null],
  ]).get(id) ?? null;
  assert.deepEqual(
    filterTopLevelSelectedIds(['parent', 'child'], getParentId),
    ['parent'],
  );
});

test('filterTopLevelSelectedIds handles several selected ancestor levels', () => {
  const getParentId = (id) => new Map([
    ['child', 'parent'],
    ['parent', 'grand-parent'],
    ['grand-parent', null],
  ]).get(id) ?? null;
  assert.deepEqual(
    filterTopLevelSelectedIds(['grand-parent', 'parent', 'child'], getParentId),
    ['grand-parent'],
  );
});

test('filterTopLevelSelectedIds keeps independent branches in input order', () => {
  const getParentId = (id) => new Map([
    ['branch-a', 'root-a'],
    ['branch-b', 'root-b'],
  ]).get(id) ?? null;
  assert.deepEqual(
    filterTopLevelSelectedIds(['branch-b', 'branch-a'], getParentId),
    ['branch-b', 'branch-a'],
  );
});

test('filterTopLevelSelectedIds keeps selected siblings in input order', () => {
  const getParentId = (id) => new Map([
    ['sibling-a', 'parent'],
    ['sibling-b', 'parent'],
  ]).get(id) ?? null;
  assert.deepEqual(
    filterTopLevelSelectedIds(['sibling-b', 'sibling-a'], getParentId),
    ['sibling-b', 'sibling-a'],
  );
});

test('filterTopLevelSelectedIds handles child-before-parent input order', () => {
  const getParentId = (id) => (id === 'child' ? 'parent' : null);
  assert.deepEqual(
    filterTopLevelSelectedIds(['child', 'parent'], getParentId),
    ['parent'],
  );
});

test('filterTopLevelSelectedIds tolerates an unknown parent', () => {
  const getParentId = (id) => (id === 'child' ? 'missing-parent' : null);
  assert.deepEqual(
    filterTopLevelSelectedIds(['child'], getParentId),
    ['child'],
  );
});

test('filterTopLevelSelectedIds leaves root exclusion to entry consumers', () => {
  const selectedIds = new Set(['root', 'parent', 'child']);
  const getParentId = (id) => (id === 'child' ? 'parent' : null);
  const entryIds = [...selectedIds].filter((id) => id !== 'root');
  assert.deepEqual(
    filterTopLevelSelectedIds(entryIds, getParentId),
    ['parent'],
  );
});

test('filterTopLevelSelectedIds does not mutate its array or Set inputs', () => {
  const ids = ['parent', 'child'];
  const selectedIds = new Set(ids);
  const getParentId = (id) => (id === 'child' ? 'parent' : null);

  filterTopLevelSelectedIds(ids, getParentId);
  filterTopLevelSelectedIds(selectedIds, getParentId);

  assert.deepEqual(ids, ['parent', 'child']);
  assert.deepEqual([...selectedIds], ['parent', 'child']);
});

test('a filtered bulk move keeps a selected child inside its selected parent', () => {
  const moveProject = {
    rootEntries: [
      {
        id: 'parent',
        type: 'menu',
        name: 'Parent',
        children: [
          { id: 'child', type: 'story', name: 'Child' },
        ],
      },
      { id: 'target', type: 'menu', name: 'Target', children: [] },
    ],
  };
  const index = buildProjectIndex(moveProject);
  const idsToMove = filterTopLevelSelectedIds(
    ['parent', 'child'],
    (id) => index.parentMenuById.get(id) ?? null,
  );
  const movedProject = idsToMove.reduce(
    (current, id) => moveEntryToContainer(current, id, 'target'),
    moveProject,
  );
  const target = movedProject.rootEntries.find((entry) => entry.id === 'target');

  assert.deepEqual(target.children.map((entry) => entry.id), ['parent']);
  assert.deepEqual(target.children[0].children.map((entry) => entry.id), ['child']);
});

test('resolveDropTargetForNode returns null for non-target nodes (perf-critical)', () => {
  const dropInfo = { targetId: 'menu-b', position: 'before', isContainer: false };
  // 99% des appels pendant un drag : node sans rapport -> null pour eviter re-render via memo.
  assert.equal(resolveDropTargetForNode('story-1', 'story', dropInfo), null);
  assert.equal(resolveDropTargetForNode('menu-a', 'menu', dropInfo), null);
});

test('resolveDropTargetForNode resolves before/after/inside on the actual target', () => {
  assert.equal(
    resolveDropTargetForNode('menu-a', 'menu', { targetId: 'menu-a', position: 'before', isContainer: false }),
    'before',
  );
  assert.equal(
    resolveDropTargetForNode('menu-a', 'menu', { targetId: 'menu-a', position: 'after', isContainer: false }),
    'after',
  );
  assert.equal(
    resolveDropTargetForNode('menu-a', 'menu', { targetId: 'menu-a', position: 'inside', isContainer: false }),
    'inside',
  );
  // story (non-menu) ne peut pas etre 'inside' target
  assert.equal(
    resolveDropTargetForNode('story-1', 'story', { targetId: 'story-1', position: 'inside', isContainer: false }),
    null,
  );
});

test('resolveDropTargetForNode treats root container drop as inside on root', () => {
  // dropInfo = drop sur la zone container racine (targetId null + isContainer true)
  const dropInfo = { targetId: null, position: 'inside', isContainer: true };
  assert.equal(resolveDropTargetForNode('root', 'root', dropInfo), 'inside');
  assert.equal(resolveDropTargetForNode('story-1', 'story', dropInfo), null);
});

test('resolveDropTargetForNode returns null for null dropInfo (idle DnD)', () => {
  assert.equal(resolveDropTargetForNode('any', 'menu', null), null);
});

test('resolveDropContainerId reads containerId, root prefix, or falls back to parent', () => {
  const getParentId = (id) => (id === 'story-1' ? 'menu-b' : null);
  assert.equal(
    resolveDropContainerId({ id: 'container:menu-a' }, null, null, true, getParentId),
    'menu-a',
  );
  assert.equal(
    resolveDropContainerId({ id: 'container:root' }, null, null, true, getParentId),
    null,
  );
  assert.equal(
    resolveDropContainerId({ id: 'whatever' }, { containerId: 'menu-x' }, null, true, getParentId),
    'menu-x',
  );
  assert.equal(
    resolveDropContainerId({ id: 'menu-a' }, null, { id: 'menu-a', type: 'menu' }, false, getParentId),
    'menu-a',
  );
  assert.equal(
    resolveDropContainerId({ id: 'story-1' }, null, { id: 'story-1', type: 'story' }, false, getParentId),
    'menu-b',
  );
});
