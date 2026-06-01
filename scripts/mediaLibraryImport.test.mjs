import test from 'node:test';
import assert from 'node:assert/strict';

import { importFilesToMediaLibrary } from '../src/hooks/mediaLibraryImport.js';

test('media library import extracts embedded audio cover as a standalone image', async () => {
  const phases = [];
  const copied = [];
  const persisted = [];

  const paths = await importFilesToMediaLibrary({
    files: ['C:/audio/story.mp3', 'C:/images/cover.jpg'],
    maybeCopyToProject: async (path) => {
      copied.push(path);
      return `copied:${path}`;
    },
    copyGeneratedMediaToProject: async (path) => {
      persisted.push(path);
      return `persisted:${path}`;
    },
    extractAudioEmbeddedImage: async (path) => (
      path === 'copied:C:/audio/story.mp3' ? 'C:/temp/metadata_123.png' : null
    ),
    setImporting: (state) => phases.push(state.phase),
    getImportDisplayName: (path) => path.split('/').pop(),
  });

  assert.deepEqual(copied, ['C:/audio/story.mp3', 'C:/images/cover.jpg']);
  assert.deepEqual(persisted, ['C:/temp/metadata_123.png']);
  assert.deepEqual(paths, [
    'copied:C:/audio/story.mp3',
    'persisted:C:/temp/metadata_123.png',
    'copied:C:/images/cover.jpg',
  ]);
  assert.ok(phases.includes('Extraction de la jaquette...'));
});
