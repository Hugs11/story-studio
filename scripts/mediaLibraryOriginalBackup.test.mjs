import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMediaLibrary } from '../src/store/mediaLibrary.js';

test('collectMediaLibrary hides original backups unless explicitly added to library paths', () => {
  const project = { rootAudio: '', rootImage: '', thumbnailImage: '', nightModeAudio: '', entries: [] };
  const original = 'C:/workspace/fichiers-importes/story.original.mp3';

  assert.deepEqual(
    collectMediaLibrary({ project, extraPaths: [] })
      .filter((item) => item.path === original),
    [],
  );

  const items = collectMediaLibrary({ project, extraPaths: [original] });
  assert.equal(items.some((item) => item.path === original), true);
});
