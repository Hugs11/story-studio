import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectData,
  projectToSerializable,
  normalizeRefEntry,
  createRefEntry,
  findIncomingRefs,
  appendEntry,
  removeEntryCascadingRefs,
  removeEntriesCascadingRefs,
} from '../src/store/projectModel.js';

function allRefIds(project) {
  const ids = [];
  const walk = (entries) => {
    for (const entry of entries ?? []) {
      if (entry.type === 'ref') ids.push(entry.id);
      if (entry.children) walk(entry.children);
    }
  };
  walk(project.rootEntries);
  return ids.sort();
}

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

test('createRefEntry builds a normalized ref pointing at an existing node', () => {
  const ref = createRefEntry({ target: 'story:story-9', refKind: 'return', label: 'Revoir' });
  assert.equal(ref.type, 'ref');
  assert.equal(ref.target, 'story:story-9');
  assert.equal(ref.refKind, 'return');
  assert.equal(ref.label, 'Revoir');
  assert.ok(ref.id, 'an id is generated');
});

test('createRefEntry appended into a menu is detected as an incoming ref of its target', () => {
  let project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [{
      id: 'menu-1',
      type: 'menu',
      name: 'Choix',
      children: [{ id: 'story-a', type: 'story', name: 'A' }],
    }],
  });
  project = appendEntry(project, 'menu-1', createRefEntry({ target: 'story:story-a' }));
  const incoming = findIncomingRefs(project, 'story-a');
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].target, 'story:story-a');
});

test('findIncomingRefs flags refs into a deleted subtree but ignores refs living inside it', () => {
  const project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [
      {
        id: 'menu-1',
        type: 'menu',
        name: 'Choix',
        children: [
          { id: 'story-a', type: 'story', name: 'A' },
          { id: 'ref-to-a', type: 'ref', target: 'story:story-a' },
        ],
      },
      {
        id: 'menu-2',
        type: 'menu',
        name: 'Autre',
        children: [
          { id: 'story-b', type: 'story', name: 'B' },
          // Cette ref vit DANS menu-2 : supprimée avec lui, donc pas « entrante ».
          { id: 'ref-inside', type: 'ref', target: 'story:story-b' },
        ],
      },
      // Ref racine qui vise menu-2 : doit être signalée si on supprime menu-2.
      { id: 'ref-to-menu2', type: 'ref', target: 'menu:menu-2' },
    ],
  });

  // Supprimer story-a → la ref-to-a (hors sous-arbre) deviendrait pendante.
  assert.deepEqual(
    findIncomingRefs(project, 'story-a').map((entry) => entry.id),
    ['ref-to-a'],
  );

  // Supprimer menu-2 → seule la ref racine compte ; ref-inside part avec le sous-arbre.
  assert.deepEqual(
    findIncomingRefs(project, 'menu-2').map((entry) => entry.id),
    ['ref-to-menu2'],
  );

  // Aucune ref n'entre dans menu-1.
  assert.deepEqual(findIncomingRefs(project, 'menu-1'), []);
});

test('removeEntryCascadingRefs drops refs that would dangle on the deleted target', () => {
  let project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [{
      id: 'menu-1',
      type: 'menu',
      name: 'Choix',
      children: [
        { id: 'story-a', type: 'story', name: 'A' },
        { id: 'story-b', type: 'story', name: 'B' },
        { id: 'ref-to-a', type: 'ref', target: 'story:story-a' },
      ],
    }],
  });

  project = removeEntryCascadingRefs(project, 'story-a');
  const menu = project.rootEntries[0];
  assert.equal(menu.children.find((c) => c.id === 'story-a'), undefined, 'la cible est supprimée');
  assert.equal(menu.children.find((c) => c.id === 'ref-to-a'), undefined, 'la ref pendante part aussi');
  assert.equal(menu.children.find((c) => c.id === 'story-b')?.id, 'story-b', 'le reste est intact');
  assert.deepEqual(allRefIds(project), [], 'aucune cible pendante ne subsiste');
});

test('removeEntriesCascadingRefs keeps refs still valid and drops only the dangling ones', () => {
  let project = normalizeProjectData({
    projectType: 'pack',
    packMetadata: {},
    rootEntries: [
      {
        id: 'menu-1',
        type: 'menu',
        name: 'Un',
        children: [
          { id: 'story-a', type: 'story', name: 'A' },
          { id: 'ref-to-b', type: 'ref', target: 'story:story-b' },
        ],
      },
      { id: 'menu-2', type: 'menu', name: 'Deux', children: [{ id: 'story-b', type: 'story', name: 'B' }] },
      { id: 'ref-to-a', type: 'ref', target: 'story:story-a' },
    ],
  });

  // Supprimer story-b → ref-to-b devient pendante (retirée) ; ref-to-a reste valide.
  project = removeEntriesCascadingRefs(project, ['story-b']);
  assert.deepEqual(allRefIds(project), ['ref-to-a']);
});
