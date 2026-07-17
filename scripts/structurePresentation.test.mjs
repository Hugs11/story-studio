import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStructureFocus,
  buildStructureProjection,
  getStoryGroupId,
  toggleStoryGroup,
} from '../src/components/diagram/diagram/structurePresentation.js';
import { getStructureLevelLayout } from '../src/components/diagram/diagram/structureLevelLayout.js';
import { getCompleteNavigationEdges } from '../src/components/diagram/flowDiagramLayout.js';

const metrics = {
  nodeWidth: 100,
  rootWidth: 120,
  nodeHeight: 96,
  nodeVisualHeight: 82,
  colGap: 12,
  rowGap: 92,
  padX: 32,
  padY: 20,
};

function project() {
  return {
    rootName: 'Racine',
    rootEntries: [{
      id: 'menu-a',
      type: 'menu',
      name: 'Dossier A',
      children: [
        { id: 'menu-b', type: 'menu', name: 'Dossier B', children: [] },
        { id: 'story-1', type: 'story', name: 'Histoire 1' },
        { id: 'story-2', type: 'story', name: 'Histoire 2' },
      ],
    }],
  };
}

test('la projection structurelle agrège les histoires sœurs au niveau réel', () => {
  const projection = buildStructureProjection(project());
  const menu = projection.children[0];
  const group = menu.children.find((child) => child.entry.type === 'story-group');

  assert.equal(projection.depth, 0);
  assert.equal(menu.depth, 1);
  assert.equal(group.depth, 2);
  assert.equal(group.entry.storyCount, 2);
  assert.deepEqual(group.entry.storyIds, ['story-1', 'story-2']);
});

test('un groupe déployé restaure les histoires sans ajouter de profondeur', () => {
  const projection = buildStructureProjection(project(), {
    expandedStoryGroupIds: new Set([getStoryGroupId('menu-a')]),
  });
  const stories = projection.children[0].children.filter((child) => child.entry.type === 'story');

  assert.deepEqual(stories.map((story) => story.id), ['story-1', 'story-2']);
  assert.ok(stories.every((story) => story.depth === 2));
});

test('un dossier avec une seule histoire reste fermé jusqu’à son ouverture', () => {
  const singleStoryProject = {
    rootName: 'Racine',
    rootEntries: [{
      id: 'menu-single',
      type: 'menu',
      name: 'Dossier unique',
      children: [{ id: 'story-single', type: 'story', name: 'Seule histoire' }],
    }],
  };
  const closed = buildStructureProjection(singleStoryProject);
  const opened = buildStructureProjection(singleStoryProject, {
    expandedStoryGroupIds: new Set([getStoryGroupId('menu-single')]),
  });

  assert.equal(closed.children[0].children[0].entry.type, 'story-group');
  assert.equal(closed.children[0].children[0].entry.storyCount, 1);
  assert.equal(opened.children[0].children[0].entry.type, 'story');
});

test('plusieurs groupes peuvent rester ouverts et un second clic referme seulement le groupe ciblé', () => {
  const groupA = getStoryGroupId('menu-a');
  const groupB = getStoryGroupId('menu-b');
  const initial = new Set();

  const withA = toggleStoryGroup(initial, groupA);
  const withBoth = toggleStoryGroup(withA, groupB);
  const withBOnly = toggleStoryGroup(withBoth, groupA);

  assert.deepEqual([...withA], [groupA]);
  assert.deepEqual([...withBoth], [groupA, groupB]);
  assert.deepEqual([...withBOnly], [groupB]);
  assert.equal(initial.size, 0);
});

test('la projection conserve simultanément les histoires de plusieurs dossiers dépliés', () => {
  const twoFolderProject = {
    rootName: 'Racine',
    rootEntries: [
      {
        id: 'menu-a',
        type: 'menu',
        name: 'Dossier A',
        children: [{ id: 'story-a', type: 'story', name: 'Histoire A' }],
      },
      {
        id: 'menu-b',
        type: 'menu',
        name: 'Dossier B',
        children: [{ id: 'story-b', type: 'story', name: 'Histoire B' }],
      },
    ],
  };
  const projection = buildStructureProjection(twoFolderProject, {
    expandedStoryGroupIds: new Set([
      getStoryGroupId('menu-a'),
      getStoryGroupId('menu-b'),
    ]),
  });

  assert.deepEqual(
    projection.children.map((menu) => menu.children.map((child) => child.entry.id)),
    [['story-a'], ['story-b']],
  );
});

test('le layout Niveaux donne le même Y aux nœuds de même profondeur', () => {
  const layout = getStructureLevelLayout(project(), metrics);
  const depthTwo = layout.nodes.filter((node) => node.depth === 2);

  assert.equal(depthTwo.length, 2);
  assert.equal(new Set(depthTwo.map((node) => node.y)).size, 1);
  assert.deepEqual(layout.bands.map((band) => band.label), ['N0', 'N1', 'N2']);
});

test('quatorze histoires restent synthétiques puis se déploient sur un seul niveau', () => {
  const fourteenStoriesProject = {
    rootName: 'Racine',
    rootEntries: [{
      id: 'menu-14',
      type: 'menu',
      name: 'Dossier',
      children: Array.from({ length: 14 }, (_, index) => ({
        id: `story-${index + 1}`,
        type: 'story',
        name: `Histoire ${index + 1}`,
      })),
    }],
  };
  const aggregated = getStructureLevelLayout(fourteenStoriesProject, metrics);
  const expanded = getStructureLevelLayout(fourteenStoriesProject, metrics, {
    expandedStoryGroupIds: new Set([getStoryGroupId('menu-14')]),
  });

  assert.equal(aggregated.nodes.filter((node) => node.entry.type === 'story-group').length, 1);
  assert.equal(aggregated.nodes.length, 3);
  const expandedStories = expanded.nodes.filter((node) => node.entry.type === 'story');
  assert.equal(expandedStories.length, 14);
  assert.equal(new Set(expandedStories.map((node) => node.y)).size, 1);
  assert.ok(expanded.width > aggregated.width);
});

test('le message de fin reste visible dans une bande dédiée hors des niveaux structurels', () => {
  const withEnd = {
    ...project(),
    globalOptions: { endNode: true },
    endNodeName: 'Bonne nuit',
  };
  const layout = getStructureLevelLayout(withEnd, metrics);
  const endNode = layout.nodes.find((node) => node.entry.id === 'end-node');

  assert.equal(layout.hasEndNode, true);
  assert.equal(endNode.entry.name, 'Bonne nuit');
  assert.equal(endNode.depth, null);
  assert.equal(endNode.width, metrics.rootWidth);
  assert.equal(endNode.height, metrics.nodeHeight);
  assert.equal(layout.bands.at(-1).kind, 'after-reading');
  assert.equal(layout.bands.at(-1).label, undefined);
});

test('le retour du message de fin rejoint les bords visuels sans les dépasser', () => {
  const withEnd = {
    ...project(),
    projectType: 'pack',
    nightModeAudio: 'night.mp3',
    globalOptions: { nightMode: true, endNode: true },
  };
  const layout = getStructureLevelLayout(withEnd, metrics, {
    expandedStoryGroupIds: new Set([getStoryGroupId('menu-a')]),
  });
  const edges = getCompleteNavigationEdges(withEnd, layout);
  const continuation = edges.find((edge) => edge.from === 'end-node');
  const endNode = layout.nodes.find((node) => node.entry.id === 'end-node');
  const target = layout.nodes.find((node) => node.entry.id === (continuation?.displayTo ?? continuation?.to));

  assert.ok(continuation);
  assert.ok(target);
  assert.equal(continuation.y1, endNode.y);
  assert.equal(continuation.y2, target.y + Math.min(target.height, metrics.nodeVisualHeight));
});

test('un retour vers une histoire cachée aboutit sur son dossier fermé sans l’ouvrir', () => {
  const crossFolderProject = {
    projectType: 'pack',
    rootName: 'Racine',
    globalOptions: {},
    rootEntries: [
      {
        id: 'menu-a',
        type: 'menu',
        name: 'Dossier A',
        children: [
          { id: 'story-a1', type: 'story', name: 'A1', controlSettings: {}, returnAfterPlay: 'story:story-b1' },
          { id: 'story-a2', type: 'story', name: 'A2', controlSettings: {} },
        ],
      },
      {
        id: 'menu-b',
        type: 'menu',
        name: 'Dossier B',
        children: [
          { id: 'story-b1', type: 'story', name: 'B1', controlSettings: {} },
          { id: 'story-b2', type: 'story', name: 'B2', controlSettings: {} },
        ],
      },
    ],
  };
  const groupB = getStoryGroupId('menu-b');
  const layout = getStructureLevelLayout(crossFolderProject, metrics, {
    expandedStoryGroupIds: new Set([getStoryGroupId('menu-a')]),
  });
  const edges = getCompleteNavigationEdges(crossFolderProject, layout);
  const crossReturn = edges.find((edge) => edge.from === 'story-a1' && edge.to === 'story-b1');

  assert.ok(layout.nodes.some((node) => node.entry.id === 'menu-b'));
  assert.ok(layout.nodes.some((node) => node.entry.id === groupB));
  assert.ok(!layout.nodes.some((node) => node.entry.id === 'story-b1'));
  assert.equal(layout.hiddenStoryGroupByStoryId.get('story-b1'), groupB);
  assert.equal(crossReturn.displayTo, groupB);
  assert.ok(Number.isFinite(crossReturn.x2));
  assert.ok(Number.isFinite(crossReturn.y2));
});

test('la focalisation remonte à la racine et distingue les frères', () => {
  const edges = [
    { id: 'root-a', from: 'root', to: 'a' },
    { id: 'a-b', from: 'a', to: 'b' },
    { id: 'a-c', from: 'a', to: 'c' },
  ];
  const labels = new Map([['root', 'Racine'], ['a', 'A'], ['b', 'B'], ['c', 'C']]);
  const focus = buildStructureFocus(edges, 'a-b', labels);

  assert.deepEqual([...focus.pathEdgeIds], ['root-a', 'a-b']);
  assert.deepEqual([...focus.pathNodeIds], ['root', 'a', 'b']);
  assert.deepEqual([...focus.siblingNodeIds], ['c']);
  assert.deepEqual(focus.breadcrumb, ['Racine', 'A', 'B']);
  assert.equal(focus.targetDepth, 2);
});
