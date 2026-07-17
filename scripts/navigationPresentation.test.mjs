import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNavigationNodeRoles,
  collectActiveNavigationPathEdges,
  compactNavigationPresentation,
  findPrimaryStoryNavigationEdge,
  navigationEdgeTouchesNode,
} from '../src/components/diagram/diagram/navigationPresentation.js';

function story(id) {
  return { id, type: 'story' };
}

test('une playlist avec messages de fin garde chaque sortie visible', () => {
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

  assert.deepEqual(presented, [
    { from: 'one', to: 'two', kind: 'after-end', source: 'prompt' },
    { from: 'two', to: 'three', kind: 'after-end', source: 'prompt' },
    { from: 'three', to: 'menu', kind: 'after-end', source: 'prompt' },
  ]);
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

test('un message global partagé conserve les parcours individuels visibles', () => {
  const project = {
    rootEntries: [{
      id: 'menu',
      type: 'menu',
      children: [story('one'), story('two'), story('three')],
    }],
  };
  const edges = ['one', 'two', 'three'].map((from, index) => ({
    from,
    to: 'end-node',
    kind: 'after-end',
    source: 'global-end',
    contextualStoryId: from,
    endNodeTargetId: ['two', 'three', 'one'][index],
  }));

  const presented = compactNavigationPresentation(project, edges);

  assert.deepEqual(presented, edges);
  assert.equal(presented.some((edge) => edge.source === 'global-group'), false);
});

test('la sélection d’une histoire choisit son trajet de fin avant son Home', () => {
  const homeEdge = { from: 'one', to: 'menu', kind: 'home' };
  const endEdge = { from: 'one', to: 'end-node', kind: 'after-end' };

  assert.equal(findPrimaryStoryNavigationEdge('one', [homeEdge, endEdge]), endEdge);
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

test('deux reprises contextuelles identiques restent deux trajets indépendants', () => {
  const storyAIn = {
    from: 'story-a',
    to: 'end-node',
    kind: 'after-end',
    contextualStoryId: 'story-a',
    endNodeTargetId: 'story-c',
  };
  const storyBIn = {
    from: 'story-b',
    to: 'end-node',
    kind: 'after-end',
    contextualStoryId: 'story-b',
    endNodeTargetId: 'story-c',
  };
  const storyAOut = {
    from: 'end-node',
    to: 'story-c',
    kind: 'after-end',
    contextualStoryId: 'story-a',
  };
  const storyBOut = {
    from: 'end-node',
    to: 'story-c',
    kind: 'after-end',
    contextualStoryId: 'story-b',
  };
  const edges = [storyAIn, storyBIn, storyAOut, storyBOut];

  assert.deepEqual(collectActiveNavigationPathEdges(storyAIn, edges), [storyAIn, storyAOut]);
  assert.equal(navigationEdgeTouchesNode(storyAOut, 'story-a'), true);
});

test('une histoire sélectionnée anime aussi la sortie globale non contextuelle', () => {
  const incoming = {
    from: 'story-a',
    to: 'end-node',
    kind: 'after-end',
    contextualStoryId: 'story-a',
    endNodeTargetId: 'menu',
  };
  const sharedOutgoing = {
    from: 'end-node',
    to: 'menu',
    kind: 'after-end',
  };

  assert.deepEqual(
    collectActiveNavigationPathEdges(incoming, [incoming, sharedOutgoing]),
    [incoming, sharedOutgoing],
  );
});
