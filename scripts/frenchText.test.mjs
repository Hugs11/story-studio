import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatFrenchCount,
  normalizeFrenchSearchText,
} from '../src/utils/frenchText.js';
import { buildProjectIndex } from '../src/store/projectModel/index.js';
import {
  buildVisibleTreeSearchIds,
} from '../src/components/TreePanel/treeSearch.js';
import {
  filterDiagramSearchCandidates,
} from '../src/components/CentralPanel/diagram/diagramSearchFilter.js';

const SEARCH_CASES = [
  ['ecole', 'École', true],
  ['ÉCOLE', 'école', true],
  ['garcon', 'Garçon', true],
  ['coeur', 'Cœur', true],
  ['oeuvre', 'Œuvre', true],
  ['aether', 'Æther', true],
  ['ete', 'Été', true],
  ['ecole', 'Collège', false],
];

for (const [query, value, expected] of SEARCH_CASES) {
  test(`French search: ${query} ${expected ? 'matches' : 'does not match'} ${value}`, () => {
    assert.equal(
      normalizeFrenchSearchText(value).includes(normalizeFrenchSearchText(query)),
      expected,
    );
  });
}

test('normalizeFrenchSearchText accepts empty, null, numeric, and spaced values', () => {
  assert.equal(normalizeFrenchSearchText(null), '');
  assert.equal(normalizeFrenchSearchText(''), '');
  assert.equal(normalizeFrenchSearchText(42), '42');
  assert.equal(normalizeFrenchSearchText('  École  '), '  ecole  ');
});

test('normalizeFrenchSearchText does not mutate the source value', () => {
  const source = 'Œuvre à l’École';
  normalizeFrenchSearchText(source);
  assert.equal(source, 'Œuvre à l’École');
});

test('formatFrenchCount uses singular only for numeric 1', () => {
  assert.equal(formatFrenchCount(0, 'élément', 'éléments'), '0 éléments');
  assert.equal(formatFrenchCount(1, 'élément', 'éléments'), '1 élément');
  assert.equal(formatFrenchCount(2, 'élément', 'éléments'), '2 éléments');
  assert.equal(formatFrenchCount('1', 'élément', 'éléments'), '1 éléments');
});

test('tree search keeps the matching entry and its ancestors visible', () => {
  const project = {
    rootEntries: [
      {
        id: 'summer',
        type: 'menu',
        name: 'Été',
        children: [
          { id: 'school', type: 'story', name: 'École' },
        ],
      },
      { id: 'college', type: 'story', name: 'Collège' },
    ],
  };
  const visibleIds = buildVisibleTreeSearchIds({
    projectIndex: buildProjectIndex(project),
    projectType: 'pack',
    searchTerm: 'ecole',
  });

  assert.deepEqual([...visibleIds].sort(), ['school', 'summer']);
});

test('diagram search uses French normalization and preserves candidate metadata', () => {
  const candidates = [
    { id: 'school', label: 'École', typeLabel: 'Histoire' },
    { id: 'heart', label: 'Cœur', typeLabel: 'Dossier' },
    { id: 'work', label: 'Œuvre audio', typeLabel: 'Histoire' },
    { id: 'college', label: 'Collège', typeLabel: 'Histoire' },
  ];

  assert.deepEqual(filterDiagramSearchCandidates(candidates, 'ecole'), [candidates[0]]);
  assert.deepEqual(filterDiagramSearchCandidates(candidates, 'coeur'), [candidates[1]]);
  assert.deepEqual(filterDiagramSearchCandidates(candidates, 'oeuvre'), [candidates[2]]);
});

test('diagram search keeps the 12-result limit', () => {
  const candidates = Array.from({ length: 15 }, (_, index) => ({
    id: `school-${index}`,
    label: `École ${index}`,
    typeLabel: 'Histoire',
  }));

  assert.equal(filterDiagramSearchCandidates(candidates, 'ecole').length, 12);
});
