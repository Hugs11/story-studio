import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectMediaLibrary,
  executeMediaDeletion,
  getEditedImageTags,
  reconcileMediaLibraryPaths,
} from '../src/store/mediaLibrary.js';
import {
  removeEntryCascadingRefs,
  updateEntry,
} from '../src/store/projectModel/operations.js';
import {
  buildEditedImageDestination,
  buildEditedImageFileName,
  isDeletableWorkspaceMediaPath,
} from '../src/store/workspaceDirs.js';
import { pathKey } from '../src/utils/fileUtils.js';

function projectWith(entries) {
  return {
    schemaVersion: 3,
    projectType: 'pack',
    projectName: 'Test',
    rootEntries: entries,
    globalOptions: {},
  };
}

test('a deleted imported story leaves its audio visible as unused', () => {
  const audio = 'C:/workspace/fichiers-importes/test__histoire.mp3';
  const project = projectWith([{ id: 'story-a', type: 'story', name: 'A', audio }]);
  const catalog = reconcileMediaLibraryPaths(project, []);
  const deleted = removeEntryCascadingRefs(project, 'story-a');

  const items = collectMediaLibrary({ project: deleted, extraPaths: catalog });

  assert.equal(items.length, 1);
  assert.equal(items[0].path, audio);
  assert.equal(items[0].inProject, false);
  assert.equal(items[0].projectUsedCount, 0);
  assert.equal(items[0].usedCount, 0);
});

test('deleting a menu keeps every descendant media in the catalog', () => {
  const menuAudio = 'C:/workspace/fichiers-importes/test__menu.mp3';
  const storyAudio = 'C:/workspace/fichiers-importes/test__story.mp3';
  const storyImage = 'C:/workspace/images-generees/test__story.png';
  const project = projectWith([{
    id: 'menu-a',
    type: 'menu',
    name: 'Menu',
    audio: menuAudio,
    children: [{ id: 'story-a', type: 'story', name: 'A', audio: storyAudio, itemImage: storyImage }],
  }]);
  const catalog = reconcileMediaLibraryPaths(project, []);
  const deleted = removeEntryCascadingRefs(project, 'menu-a');

  const items = collectMediaLibrary({ project: deleted, extraPaths: catalog });

  assert.deepEqual(new Set(items.map((item) => item.path)), new Set([menuAudio, storyAudio, storyImage]));
  assert.ok(items.every((item) => !item.inProject));
});

test('removing one of several shared usages keeps the remaining usage intact', () => {
  const sharedAudio = 'C:/workspace/fichiers-importes/test__shared.mp3';
  const project = projectWith([
    { id: 'story-a', type: 'story', name: 'A', audio: sharedAudio },
    { id: 'story-b', type: 'story', name: 'B', audio: sharedAudio },
  ]);
  const catalog = reconcileMediaLibraryPaths(project, []);
  const updated = removeEntryCascadingRefs(project, 'story-a');

  const [item] = collectMediaLibrary({ project: updated, extraPaths: catalog });

  assert.equal(item.inProject, true);
  assert.equal(item.projectUsedCount, 1);
  assert.equal(item.usedCount, 1);
});

test('clearing or replacing a field leaves the previous media unused in the catalog', () => {
  const previousAudio = 'C:/workspace/fichiers-importes/test__old.mp3';
  const nextAudio = 'C:/workspace/fichiers-importes/test__new.mp3';
  const previousImage = 'C:/workspace/images-generees/test__old.png';
  const nextImage = 'C:/workspace/images-generees/test__new.png';
  const project = projectWith([{
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: previousAudio,
    itemImage: previousImage,
  }]);
  const catalog = reconcileMediaLibraryPaths(project, []);
  const updated = updateEntry(project, 'story-a', { audio: nextAudio, itemImage: nextImage });
  const nextCatalog = reconcileMediaLibraryPaths(updated, catalog);

  const items = collectMediaLibrary({ project: updated, extraPaths: nextCatalog });
  const previous = items.find((item) => pathKey(item.path) === pathKey(previousAudio));
  const current = items.find((item) => pathKey(item.path) === pathKey(nextAudio));
  const previousImageItem = items.find((item) => pathKey(item.path) === pathKey(previousImage));
  const currentImageItem = items.find((item) => pathKey(item.path) === pathKey(nextImage));

  assert.equal(previous?.inProject, false);
  assert.equal(current?.inProject, true);
  assert.equal(previousImageItem?.inProject, false);
  assert.equal(currentImageItem?.inProject, true);
});

test('media deletion is blocked while the media is used', async () => {
  const events = [];
  const result = await executeMediaDeletion({
    item: { path: 'C:/used.mp3', inProject: true, projectUsedCount: 2 },
    deleteFromDisk: true,
    deleteDisk: async () => { events.push('disk'); },
    commitRemoval: () => { events.push('commit'); },
  });

  assert.equal(result.blocked, true);
  assert.equal(result.usedCount, 2);
  assert.deepEqual(events, []);
});

test('a refused disk deletion leaves the application state untouched', async () => {
  const events = [];
  const result = await executeMediaDeletion({
    item: { path: 'C:/external.mp3', inProject: false, projectUsedCount: 0 },
    deleteFromDisk: true,
    deleteDisk: async () => {
      events.push('disk');
      throw new Error('refused');
    },
    commitRemoval: () => { events.push('commit'); },
  });

  assert.equal(result.removed, false);
  assert.match(result.diskError, /refused/);
  assert.deepEqual(events, ['disk']);
});

test('a successful disk deletion commits application cleanup afterwards', async () => {
  const events = [];
  const result = await executeMediaDeletion({
    item: { path: 'C:/workspace/fichiers-importes/test.mp3', inProject: false, projectUsedCount: 0 },
    deleteFromDisk: true,
    deleteDisk: async () => { events.push('disk'); },
    commitRemoval: () => { events.push('commit'); },
  });

  assert.equal(result.removed, true);
  assert.equal(result.diskDeleted, true);
  assert.deepEqual(events, ['disk', 'commit']);
});

test('disk deletion eligibility is limited to deletable workspace media folders', () => {
  const workspace = 'C:/Users/test/story-studio';

  assert.equal(isDeletableWorkspaceMediaPath(
    'C:/Users/test/story-studio/fichiers-importes/test.mp3',
    workspace,
  ), true);
  assert.equal(isDeletableWorkspaceMediaPath(
    'C:/Users/test/story-studio/zips-extraits/pack/audio.mp3',
    workspace,
  ), false);
  assert.equal(isDeletableWorkspaceMediaPath(
    'C:/Users/test/story-studio-copy/fichiers-importes/test.mp3',
    workspace,
  ), false);
  assert.equal(isDeletableWorkspaceMediaPath('D:/external/test.mp3', workspace), false);
});

test('edited image names stay readable and resolve collisions without changing the source stem', () => {
  assert.equal(buildEditedImageFileName('C:/photos/La forêt.png'), 'La forêt_modifie.png');
  assert.equal(buildEditedImageFileName('C:/photos/La forêt.png', 2), 'La forêt_modifie_2.png');
  assert.equal(buildEditedImageFileName('C:/photos/La forêt_modifie_7.png'), 'La forêt_modifie.png');
  assert.equal(
    buildEditedImageDestination('C:/workspace', 'D:/sources/La forêt.png', 3),
    'C:/workspace/images-generees/La forêt_modifie_3.png',
  );
});

test('an edited image copies source tags case-insensitively and adds its distinctive tag', () => {
  const sourcePath = 'C:\\Images\\Source.PNG';
  const mediaTags = { 'c:/images/source.png': ['couverture', 'favori'] };

  const result = getEditedImageTags(mediaTags, sourcePath);

  assert.deepEqual(result, ['couverture', 'favori', 'modifiée']);
  assert.deepEqual(mediaTags, { 'c:/images/source.png': ['couverture', 'favori'] });
});

test('one reusable edited image keeps a single catalog entry across several placeholders', () => {
  const derivative = 'C:/workspace/images-generees/visuel_modifie.png';
  const emptyProject = projectWith([]);
  const [unused] = collectMediaLibrary({ project: emptyProject, extraPaths: [derivative] });
  assert.equal(unused.inProject, false);
  assert.equal(unused.usedCount, 0);

  const usedTwice = projectWith([
    { id: 'story-a', type: 'story', name: 'A', itemImage: derivative },
    { id: 'story-b', type: 'story', name: 'B', itemImage: derivative },
  ]);
  const [shared] = collectMediaLibrary({ project: usedTwice, extraPaths: [derivative] });
  assert.equal(shared.path, derivative);
  assert.equal(shared.projectUsedCount, 2);
  assert.equal(shared.usages.length, 2);

  const firstRemoved = updateEntry(usedTwice, 'story-a', { itemImage: null });
  const [remaining] = collectMediaLibrary({ project: firstRemoved, extraPaths: [derivative] });
  assert.equal(remaining.projectUsedCount, 1);
  assert.equal(pathKey(remaining.path), pathKey(derivative));
});
