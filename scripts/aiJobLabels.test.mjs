import test from 'node:test';
import assert from 'node:assert/strict';

import { getImageJobTargetLabel } from '../src/store/aiJobLabels.js';

function index(entries) {
  return {
    entryById: new Map(entries.map((entry) => [entry.id, entry])),
  };
}

test('labels story selection image jobs from field id', () => {
  const projectIndex = index([{ id: 'story-1', name: 'Azuro et les dinosaures' }]);

  assert.equal(
    getImageJobTargetLabel({ fieldId: 'story-1:itemImage' }, projectIndex),
    'Azuro et les dinosaures - image de selection',
  );
});

test('labels menu and root image jobs from field id', () => {
  const projectIndex = index([{ id: 'folder-1', name: 'Chapitre 1' }]);

  assert.equal(
    getImageJobTargetLabel({ fieldId: 'folder-1:image' }, projectIndex),
    'Chapitre 1 - image du dossier',
  );
  assert.equal(
    getImageJobTargetLabel({ fieldId: 'root:thumbnailImage' }, projectIndex),
    'Menu racine - vignette catalogue',
  );
});

test('keeps explicit labels for image jobs without field id', () => {
  assert.equal(
    getImageJobTargetLabel({ currentImageLabel: 'Image de test' }, null),
    'Image de test',
  );
});

test('keeps regenerated image job destination', () => {
  assert.equal(
    getImageJobTargetLabel({ regenerateJob: { targetLabel: 'Histoire - image de selection' } }, null),
    'Histoire - image de selection',
  );
});
