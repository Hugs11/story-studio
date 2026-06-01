import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeImportedName } from '../src/store/importedNames.js';

test('sanitizeImportedName can preserve hyphens for audio-derived story names', () => {
  assert.equal(
    sanitizeImportedName('chapitre-01-la-foret', '', { preserveHyphens: true }),
    'chapitre-01-la-foret',
  );
});

test('sanitizeImportedName keeps legacy import behavior by default', () => {
  assert.equal(sanitizeImportedName('chapitre-01_la-foret'), 'chapitre 01 la foret');
});
