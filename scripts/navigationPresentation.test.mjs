import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNavigationNodeRoles,
  collectActiveNavigationPathEdges,
  compactNavigationPresentation,
  navigationEdgeTouchesNode,
} from '../src/components/CentralPanel/diagram/navigationPresentation.js';

function story(id) {
  return { id, type: 'story' };
}

test('une playlist avec message de fin garde seulement sa sortie réelle', () => {
  const project = {
    rootEntries: [{
      id: 'menu',
      type: 'menu',
      children: [story('one'), story('two'), story('three')],
    }],
  };
  const edges = [
    { from: 'one', to: 'two', kind: 'return', source: 'prompt' },
    { from: 'two', to: 'three', kind: 'return', source: 'prompt' },
    { from: 'three', to: 'menu', kind: 'return', source: 'prompt' },
  ];

  const presented = compactNavigationPresentation(project, edges);

  assert.equal(presented.length, 1);
  assert.deepEqual(presented[0], {
    from: 'three',
    to: 'menu',
    kind: 'after-end',
    source: 'prompt-chain',
    chainStoryIds: ['one', 'two', 'three'],
  });
  assert.equal(navigationEdgeTouchesNode(presented[0], 'one'), true);
});

test('un enchaînement court conserve ses transitions visibles après le message de fin', () => {
  const project = {
    rootEntries: [{
      id: 'menu',
      type: 'menu',
      children: [story('one'), story('two')],
    }],
  };
  const edges = [
    { from: 'one', to: 'two', kind: 'return', source: 'prompt' },
    { from: 'two', to: 'menu', kind: 'return', source: 'prompt' },
  ];

  assert.deepEqual(compactNavigationPresentation(project, edges), [
    { from: 'one', to: 'two', kind: 'after-end', source: 'prompt' },
    { from: 'two', to: 'menu', kind: 'after-end', source: 'prompt' },
  ]);
});

test('une séquence de fin utilise la même sémantique de sortie', () => {
  const edges = [{ from: 'story', to: 'menu', kind: 'sequence', source: 'configured', label: 'Fin -> titre' }];

  assert.deepEqual(compactNavigationPresentation({ rootEntries: [] }, edges), [{
    from: 'story',
    to: 'menu',
    kind: 'after-end',
    source: 'sequence',
    label: 'Fin -> titre',
  }]);
});

test('un message global partagé est regroupé par dossier avant de rejoindre son nœud', () => {
  const project = {
    rootEntries: [{
      id: 'menu',
      type: 'menu',
      children: [story('one'), story('two'), story('three')],
    }],
  };
  const layout = {
    metrics: { nodeVisualHeight: 62 },
    nodes: [
      { entry: { id: 'menu' }, x: 100, y: 20, width: 86, height: 74 },
      { entry: { id: 'one' }, x: 20, y: 160, width: 86, height: 74 },
      { entry: { id: 'two' }, x: 120, y: 160, width: 86, height: 74 },
      { entry: { id: 'three' }, x: 220, y: 160, width: 86, height: 74 },
      { entry: { id: 'end-node' }, x: 120, y: 300, width: 86, height: 74 },
    ],
  };
  const edges = ['one', 'two', 'three'].map((from) => ({
    from,
    to: 'end-node',
    kind: 'after-end',
    source: 'global-end',
  }));

  const presented = compactNavigationPresentation(project, edges, layout);

  assert.equal(presented.length, 1);
  assert.equal(presented[0].from, 'menu');
  assert.equal(presented[0].source, 'global-group');
  assert.deepEqual(presented[0].chainStoryIds, ['one', 'two', 'three']);
});

test('les histoires d’un retour regroupé sont des membres, pas des extrémités actives', () => {
  const roles = buildNavigationNodeRoles({
    from: 'menu',
    to: 'end-node',
    chainStoryIds: ['one', 'two', 'three'],
  });

  assert.deepEqual([...roles.activeNodeIds], ['menu', 'end-node']);
  assert.deepEqual([...roles.memberNodeIds], ['one', 'two', 'three']);
});

test('les deux segments d’une fin locale forment un seul trajet actif', () => {
  const edges = [
    {
      from: 'story-a',
      to: 'local-end:story-a',
      kind: 'after-end',
      localEndLeg: 'start',
      localEndStoryId: 'story-a',
    },
    {
      from: 'local-end:story-a',
      to: 'story-b',
      kind: 'after-end',
      localEndLeg: 'exit',
      localEndStoryId: 'story-a',
    },
  ];

  assert.deepEqual(collectActiveNavigationPathEdges(edges[0], edges), edges);
  assert.deepEqual(collectActiveNavigationPathEdges(edges[1], edges), edges);

  const roles = buildNavigationNodeRoles(edges[0], edges);
  assert.deepEqual([...roles.activeNodeIds], ['story-a', 'local-end:story-a', 'story-b']);
  assert.deepEqual([...roles.memberNodeIds], []);
});

test('les deux côtés du message global forment un seul trajet actif', () => {
  const edges = [
    {
      from: 'story-a',
      to: 'end-node',
      kind: 'after-end',
      endNodeTargetId: 'story-b',
    },
    {
      from: 'end-node',
      to: 'story-b',
      kind: 'after-end',
    },
  ];

  assert.deepEqual(collectActiveNavigationPathEdges(edges[0], edges), edges);
  assert.deepEqual(collectActiveNavigationPathEdges(edges[1], edges), edges);

  const roles = buildNavigationNodeRoles(edges[1], edges);
  assert.deepEqual([...roles.activeNodeIds], ['story-a', 'end-node', 'story-b']);
});
