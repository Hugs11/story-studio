import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeImportedEntries, sanitizeImportedName } from '../src/store/importedNames.js';

test('sanitizeImportedName can preserve hyphens for audio-derived story names', () => {
  assert.equal(
    sanitizeImportedName('chapitre-01-la-foret', '', { preserveHyphens: true }),
    'chapitre-01-la-foret',
  );
});

test('sanitizeImportedName keeps legacy import behavior by default', () => {
  assert.equal(sanitizeImportedName('chapitre-01_la-foret'), 'chapitre 01 la foret');
});

test('sanitizeImportedEntries increments duplicate names across an extracted tree', () => {
  const entries = sanitizeImportedEntries([
    {
      id: 'menu-1',
      type: 'menu',
      name: 'Stage title',
      children: [
        { id: 'story-1', type: 'story', name: 'Stage title' },
        { id: 'story-2', type: 'story', name: 'Stage title 2' },
      ],
    },
    { id: 'story-3', type: 'story', name: 'Stage title' },
  ]);

  assert.deepEqual(
    [
      entries[0].name,
      entries[0].children[0].name,
      entries[0].children[1].name,
      entries[1].name,
    ],
    ['Stage title', 'Stage title 3', 'Stage title 2', 'Stage title 4'],
  );
});
