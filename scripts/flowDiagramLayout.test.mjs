import test from 'node:test';
import assert from 'node:assert/strict';

import { getCompleteNavigationEdges } from '../src/components/diagram/flowDiagramLayout.js';
import { getStoryGroupId } from '../src/components/diagram/diagram/structurePresentation.js';
import { getStructureLevelLayout } from '../src/components/diagram/diagram/structureLevelLayout.js';
import { buildGroupedLayoutRows, orderDiagramChildren } from '../src/components/diagram/diagram/storyGroupLayout.js';

const diagramMetrics = {
  nodeWidth: 100,
  rootWidth: 120,
  nodeHeight: 96,
  nodeVisualHeight: 82,
  colGap: 12,
  rowGap: 92,
  padX: 32,
  padY: 20,
};

function projectWithStoryHome(returnOnHome) {
  return {
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [{
      id: 'menu-a',
      type: 'menu',
      name: 'Dossier A',
      children: [
        { id: 'story-a', type: 'story', name: 'Histoire A', returnOnHome, controlSettings: { home: true } },
        { id: 'story-b', type: 'story', name: 'Histoire B', controlSettings: { home: true } },
      ],
    }],
  };
}

function navigationEdgesFor(project) {
  const layout = getStructureLevelLayout(project, diagramMetrics, {
    expandedStoryGroupIds: new Set([getStoryGroupId('menu-a')]),
  });
  return getCompleteNavigationEdges(project, layout);
}

function projectWithContextualGlobalEnd() {
  const promptControls = {
    autoplay: false,
    wheel: false,
    pause: false,
    ok: true,
    home: true,
  };
  const makeStory = (id, okTarget) => ({
    id,
    type: 'story',
    name: id,
    afterPlaybackPromptAudio: 'night.mp3',
    afterPlaybackPromptControlSettings: promptControls,
    afterPlaybackPromptOkTarget: okTarget,
    afterPlaybackPromptHomeTarget: null,
    afterPlaybackPromptHomeNone: true,
    afterPlaybackSequence: [],
    controlSettings: { home: true },
  });
  return {
    projectType: 'pack',
    globalOptions: {},
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'next_story',
    nightModeHomeReturn: null,
    rootEntries: [{
      id: 'menu-a',
      type: 'menu',
      name: 'Dossier A',
      children: [
        makeStory('story-a', 'story:story-b'),
        makeStory('story-b', 'story:story-c'),
        makeStory('story-c', 'menu:menu-a'),
      ],
    }],
  };
}

test('le diagramme place les dossiers avant les histoires sans modifier leur ordre interne', () => {
  const children = [
    { id: 'story-1', type: 'story' },
    { id: 'menu-1', type: 'menu' },
    { id: 'story-2', type: 'story' },
    { id: 'zip-1', type: 'zip' },
  ];

  const ordered = orderDiagramChildren(children, (entry) => entry.type === 'menu' || entry.type === 'zip');

  assert.deepEqual(ordered.map((entry) => entry.id), ['menu-1', 'zip-1', 'story-1', 'story-2']);
});

test('un petit groupe d’histoires conserve les liens structurels individuels', () => {
  const rows = buildGroupedLayoutRows({
    blocks: Array.from({ length: 8 }, (_, index) => ({ id: index })),
    rowLimit: 8,
    kind: 'story',
    groupIndex: 0,
    groupSize: 8,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].isAggregateStoryGroup, false);
});

test('un groupe d’histoires sur plusieurs rangées devient un conteneur agrégé', () => {
  const rows = buildGroupedLayoutRows({
    blocks: Array.from({ length: 9 }, (_, index) => ({ id: index })),
    rowLimit: 8,
    kind: 'story',
    groupIndex: 0,
    groupSize: 9,
  });

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.isAggregateStoryGroup));
});

test('les autres groupes gardent leurs liens individuels même sur plusieurs rangées', () => {
  const rows = buildGroupedLayoutRows({
    blocks: Array.from({ length: 5 }, (_, index) => ({ id: index })),
    rowLimit: 3,
    kind: 'structural',
    groupIndex: 0,
    groupSize: 5,
  });

  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => !row.isAggregateStoryGroup));
});

test('un Home interne lecture vers sélection de la même histoire ne dessine pas de boucle', () => {
  const edges = navigationEdgesFor(projectWithStoryHome('story:story-a'));

  assert.equal(edges.some((edge) => edge.kind === 'home' && edge.from === 'story-a'), false);
});

test('un Home vers une autre histoire reste visible dans le diagramme', () => {
  const edges = navigationEdgesFor(projectWithStoryHome('story:story-b'));

  assert.ok(edges.some((edge) => (
    edge.kind === 'home' && edge.from === 'story-a' && edge.to === 'story-b'
  )));
});

test('un dossier déplié affiche chaque trajet contextuel via le message de fin', () => {
  const edges = navigationEdgesFor(projectWithContextualGlobalEnd());
  const incoming = edges.filter((edge) => edge.to === 'end-node' && edge.source === 'global-end');
  const outgoing = edges.filter((edge) => edge.from === 'end-node' && edge.source === 'contextual');

  assert.deepEqual(incoming.map((edge) => [edge.from, edge.endNodeTargetId]), [
    ['story-a', 'story-b'],
    ['story-b', 'story-c'],
    ['story-c', 'menu-a'],
  ]);
  assert.deepEqual(outgoing.map((edge) => [edge.contextualStoryId, edge.to]), [
    ['story-a', 'story-b'],
    ['story-b', 'story-c'],
    ['story-c', 'menu-a'],
  ]);
  assert.equal(edges.some((edge) => edge.source === 'global-group'), false);
});

test('un dossier replié ne fabrique aucun retour condensé pour une reprise contextuelle', () => {
  const project = projectWithContextualGlobalEnd();
  const layout = getStructureLevelLayout(project, diagramMetrics, {
    expandedStoryGroupIds: new Set(),
  });
  const edges = getCompleteNavigationEdges(project, layout);

  assert.equal(edges.some((edge) => edge.to === 'end-node' || edge.from === 'end-node'), false);
});
