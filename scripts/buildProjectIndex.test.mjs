import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProjectIndex,
  findEntryPath,
  findParentMenuId,
  getPlayableDescendantCount,
} from '../src/store/projectModel.js';

function story(id, fields = {}) {
  return {
    id,
    type: 'story',
    name: id,
    audio: `${id}.mp3`,
    ...fields,
  };
}

function menu(id, children = [], fields = {}) {
  return {
    id,
    type: 'menu',
    name: id,
    children,
    ...fields,
  };
}

test('buildProjectIndex records duplicate entry ids without dropping traversal data', () => {
  const duplicateRootStory = story('duplicate', { name: 'Root duplicate' });
  const duplicateNestedStory = story('duplicate', { name: 'Nested duplicate' });
  const project = {
    schemaVersion: 3,
    rootEntries: [
      duplicateRootStory,
      menu('menu-1', [duplicateNestedStory, story('child-2')]),
    ],
  };

  const index = buildProjectIndex(project);

  assert.equal(index.entryIdCounts.get('duplicate'), 2);
  assert.equal(index.flatEntries.length, 4);
  assert.equal(index.rootPlayableCount, 3);
  assert.equal(index.entryById.get('duplicate'), duplicateNestedStory);
  assert.deepEqual(findEntryPath(project, 'duplicate', index), [project.rootEntries[1], duplicateNestedStory]);
  assert.equal(findParentMenuId(project, 'duplicate', index), 'menu-1');
});

test('buildProjectIndex handles an empty project shape', () => {
  const index = buildProjectIndex({ schemaVersion: 3, rootEntries: [] });

  assert.equal(index.rootPlayableCount, 0);
  assert.equal(index.flatEntries.length, 0);
  assert.equal(index.firstSimpleStory, null);
  assert.equal(index.entryById.size, 0);
  assert.equal(index.entryIdCounts.size, 0);
});

test('buildProjectIndex treats missing rootEntries as an empty pre-normalized project', () => {
  for (const project of [
    { schemaVersion: 1, rootItems: [story('legacy-root')] },
    { schemaVersion: 2, menus: [menu('legacy-menu', [story('legacy-child')])] },
    { schemaVersion: 3 },
  ]) {
    const index = buildProjectIndex(project);

    assert.equal(index.rootPlayableCount, 0);
    assert.equal(index.flatEntries.length, 0);
    assert.equal(index.entryIdCounts.size, 0);
  }
});

test('buildProjectIndex tracks parent menus and playable descendant counts', () => {
  const nestedMenu = menu('nested-menu', [story('nested-story')]);
  const rootMenu = menu('root-menu', [
    story('story-a'),
    nestedMenu,
    { id: 'zip-a', type: 'zip', name: 'Zip A', path: 'pack.zip' },
  ]);
  const project = {
    schemaVersion: 3,
    rootEntries: [rootMenu, story('root-story')],
  };

  const index = buildProjectIndex(project);

  assert.equal(index.rootPlayableCount, 4);
  assert.equal(index.firstSimpleStory.id, 'story-a');
  assert.equal(findParentMenuId(project, 'nested-story', index), 'nested-menu');
  assert.equal(getPlayableDescendantCount(index, 'root-menu'), 3);
  assert.equal(getPlayableDescendantCount(index, 'nested-menu'), 1);
  assert.equal(getPlayableDescendantCount(index, 'zip-a'), 1);
});

test('buildProjectIndex ignores stale sharedEntries outside the visible tree', () => {
  const sharedMenu = menu('shared-menu', [story('shared-story')]);
  const project = {
    schemaVersion: 3,
    rootEntries: [{ id: 'ref-to-shared', type: 'ref', target: 'story:shared-story' }],
    sharedEntries: [sharedMenu],
  };

  const index = buildProjectIndex(project);

  assert.equal(index.rootPlayableCount, 1);
  assert.equal(Object.hasOwn(index, 'sharedPlayableCount'), false);
  assert.equal(index.flatEntries.length, 1);
  assert.equal(index.entryById.get('shared-story'), undefined);
  assert.equal(findEntryPath(project, 'shared-story', index), null);
  assert.equal(findParentMenuId(project, 'shared-story', index), null);
});
