import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectData,
  projectToSerializable,
  normalizeRefEntry,
} from '../src/store/projectModel.js';

test('normalizeRefEntry keeps a typed navigation target', () => {
  const ref = normalizeRefEntry({ id: 'r1', type: 'ref', target: 'story:story-9' });
  assert.equal(ref.type, 'ref');
  assert.equal(ref.target, 'story:story-9');
  assert.equal(ref.refKind, 'continue');
  assert.equal(ref.label, '');
  assert.equal(ref.nativeStageId, null);
});

test('normalizeRefEntry treats a bare id as a menu target and falls back from targetId', () => {
  const bare = normalizeRefEntry({ type: 'ref', target: 'menu-7' });
  assert.equal(bare.target, 'menu:menu-7');
  const legacy = normalizeRefEntry({ type: 'ref', targetId: 'story:legacy' });
  assert.equal(legacy.target, 'story:legacy');
  const empty = normalizeRefEntry({ type: 'ref' });
  assert.equal(empty.target, null);
});

test('normalizeRefEntry keeps an explicit return kind and label', () => {
  const ref = normalizeRefEntry({
    type: 'ref',
    target: 'menu:menu-3',
    refKind: 'return',
    label: 'Revient à A',
  });
  assert.equal(ref.refKind, 'return');
  assert.equal(ref.label, 'Revient à A');
  assert.ok(ref.id, 'a missing id is generated');
});

test('a ref inside a menu survives normalization and is not reclassified', () => {
  const project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [{
      id: 'menu-1',
      type: 'menu',
      name: 'Choix',
      children: [
        { id: 'story-a', type: 'story', name: 'Branche A' },
        { id: 'ref-1', type: 'ref', target: 'story:story-a', refKind: 'return' },
      ],
    }],
  });
  const menu = project.rootEntries[0];
  assert.equal(menu.children.length, 2);
  assert.equal(menu.children[1].type, 'ref');
  assert.equal(menu.children[1].target, 'story:story-a');
});

test('a root-level ref stays a ref (not coerced into a story)', () => {
  const project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [
      { id: 'story-a', type: 'story', name: 'A' },
      { id: 'ref-1', type: 'ref', target: 'story:story-a' },
    ],
  });
  assert.equal(project.rootEntries.length, 2);
  assert.equal(project.rootEntries[1].type, 'ref');
  assert.equal(project.nativeGraph, null);
});

test('a ref round-trips through serialization', () => {
  const project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [{ id: 'ref-1', type: 'ref', target: 'story_play:t', refKind: 'return', label: 'Revient à A' }],
  });
  const reopened = normalizeProjectData(projectToSerializable(project));
  assert.equal(reopened.rootEntries[0].type, 'ref');
  assert.equal(reopened.rootEntries[0].target, 'story_play:t');
  assert.equal(reopened.rootEntries[0].label, 'Revient à A');
  assert.equal(reopened.rootEntries[0].refKind, 'return');
});
