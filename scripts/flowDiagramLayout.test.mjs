import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupedLayoutRows, orderDiagramChildren } from '../src/components/CentralPanel/diagram/storyGroupLayout.js';

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
