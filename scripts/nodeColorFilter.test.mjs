import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUsedNodeColors,
  collectProjectUsedNodeColors,
  matchesNodeColor,
  toggleNodeColorFilter,
} from '../src/components/tree/nodeColorFilter.js';
import { buildProjectIndex } from '../src/store/projectModel/index.js';
import { buildVisibleTreeSearchIds } from '../src/components/TreePanel/treeSearch.js';
import {
  buildDiagramSearchContextIds,
  diagramEntryMatchesSearch,
  filterDiagramSearchCandidates,
} from '../src/components/diagram/diagram/diagramSearchFilter.js';

const RED = '#e24b4a';
const BLUE = '#3d9be9';

test('used colors follow palette order and expose their project-wide counts', () => {
  assert.deepEqual(buildUsedNodeColors([BLUE, RED, RED, null]), [
    { color: RED, count: 2, label: 'Rouge' },
    { color: BLUE, count: 1, label: 'Bleu' },
  ]);

  const project = {
    treeColor: RED,
    rootEntries: [{ id: 'story', type: 'story', name: 'Conte', treeColor: RED }],
  };
  assert.deepEqual(collectProjectUsedNodeColors(project, buildProjectIndex(project)), [
    { color: RED, count: 2, label: 'Rouge' },
  ]);
});

test('color selection toggles independently and matches any selected color', () => {
  const redOnly = toggleNodeColorFilter(new Set(), RED);
  const redAndBlue = toggleNodeColorFilter(redOnly, BLUE);

  assert.equal(matchesNodeColor(RED, redAndBlue), true);
  assert.equal(matchesNodeColor(BLUE, redAndBlue), true);
  assert.equal(matchesNodeColor('#5fbf6b', redAndBlue), false);
  assert.deepEqual([...toggleNodeColorFilter(redAndBlue, RED)], [BLUE]);
});

test('tree color filtering keeps matching entries and their ancestors', () => {
  const project = {
    rootEntries: [{
      id: 'folder',
      type: 'menu',
      name: 'Contes',
      children: [
        { id: 'red-story', type: 'story', name: 'Renard', treeColor: RED },
        { id: 'blue-story', type: 'story', name: 'Renard bleu', treeColor: BLUE },
      ],
    }],
  };
  const projectIndex = buildProjectIndex(project);

  assert.deepEqual([...buildVisibleTreeSearchIds({
    projectIndex,
    projectType: 'pack',
    searchTerm: '',
    selectedColors: new Set([RED]),
  })].sort(), ['folder', 'red-story']);

  assert.deepEqual([...buildVisibleTreeSearchIds({
    projectIndex,
    projectType: 'pack',
    searchTerm: 'bleu',
    selectedColors: new Set([RED]),
  })], []);
});

test('diagram combines text and color filters without truncating a color result set', () => {
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    id: `story-${index}`,
    label: index === 0 ? 'Renard' : `Conte ${index}`,
    treeColor: RED,
  }));
  candidates.push({ id: 'blue', label: 'Renard bleu', treeColor: BLUE });

  assert.equal(filterDiagramSearchCandidates(
    candidates,
    '',
    Number.POSITIVE_INFINITY,
    new Set([RED]),
  ).length, 15);
  assert.deepEqual(filterDiagramSearchCandidates(
    candidates,
    'renard',
    Number.POSITIVE_INFINITY,
    new Set([RED]),
  ).map(({ id }) => id), ['story-0']);
});

test('diagram keeps parent context and treats a collapsed matching group as a result', () => {
  const parents = new Map([
    ['story', 'folder'],
    ['folder', null],
  ]);
  const matchingIds = new Set(['story']);

  assert.deepEqual([...buildDiagramSearchContextIds(matchingIds, parents)].sort(), ['folder', 'root']);
  assert.equal(diagramEntryMatchesSearch({
    id: 'story-group:folder',
    type: 'story-group',
    storyIds: ['story'],
  }, matchingIds), true);
  assert.equal(diagramEntryMatchesSearch({ id: 'other', type: 'story' }, matchingIds), false);
});
