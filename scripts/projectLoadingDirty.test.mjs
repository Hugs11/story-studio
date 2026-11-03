import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useProjectLoading } = await import('../src/hooks/useProjectLoading.js');
const { decodeProjectFile } = await import('../src/store/projectModel/codec.js');
const { hasUnsavedWork } = await import('../src/store/projectHelpers.js');
const { askSaveBeforeLeave } = await import('../src/hooks/saveBeforeLeave.js');
const noop = () => {};

for (const savedStorage of [false, true]) test(`opening a menu project stays clean without edits (saved storage: ${savedStorage})`, async () => {
  const raw = { projectType: 'pack', projectName: 'Musiques Armand', rootEntries: [
    { id: 'song', type: 'story', name: 'Musique', audio: '/media/song.mp3' },
  ], ...(savedStorage ? { storage: { version: 1, workId: '12345678-1234-4234-8234-123456789abc', folder: 'Musiques Armand', provisional: false } } : {}) };
  const { project } = await decodeProjectFile(JSON.stringify(raw), { savePath: '/projects/music.mbah' });
  const savedSnapshotRef = { current: null };
  let store, loading; let prompts = 0;
  const library = { current: [] };
  const app = runner(() => {
    store = useProjectStore();
    loading = useProjectLoading({ store, savedSnapshotRef, sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
      setMediaLibraryPaths: paths => { library.current = paths; }, setRecentProjects: noop,
      autoSavePathRef: { current: null }, autoSaveSnapshotRef: { current: null }, setAutoSavedPath: noop,
      confirmSaveBeforeLeaveCurrent: async () => true, showErrorDialog: noop });
  });
  const work = () => ({ project: store.readProject(), savePath: '/projects/music.mbah', mediaLibraryPaths: library.current, mediaTags: store.readMediaTags(), savedSnapshot: savedSnapshotRef.current });
  const leave = () => askSaveBeforeLeave(work, noop, async () => { prompts++; return 'cancel'; });
  try {
    app.render();
    await loading.applyLoadedProject({ data: project, path: '/projects/music.mbah', mediaLibraryPaths: ['/media/song.mp3'], mediaTags: {} });
    app.render(); app.flush();
    assert.deepEqual(store.readProject(), project, 'installation preserves all author values');
    assert.equal(hasUnsavedWork(work()), false, 'loading and normalization are not user edits');
    assert.equal(await leave(), true); assert.equal(prompts, 0);
    store.updateProjectName('Musique corrigée'); app.render();
    assert.equal(await leave(), false); assert.equal(prompts, 1, 'a genuine edit still asks before departure');
    store.undo(); app.render();
    assert.equal(await leave(), true); assert.equal(prompts, 1, 'undo to the loaded state restores cleanliness');
    store.updateItem('song', { audio: '/media/other.mp3' }); app.render();
    assert.equal(hasUnsavedWork(work()), true, 'media replacement remains an edit');
  } finally { app.unmount(); }
});

test('menu snapshots ignore object key order but preserve story order and authored metadata', async () => {
  const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
  const first = { projectType: 'pack', packMetadata: { title: 'Musique', version: 1 }, rootEntries: [
    { id: 'a', type: 'story', name: 'A' }, { id: 'b', type: 'story', name: 'B' },
  ] };
  const reordered = { rootEntries: [
    { name: 'A', type: 'story', id: 'a' }, { name: 'B', id: 'b', type: 'story' },
  ], packMetadata: { version: 1, title: 'Musique' }, projectType: 'pack' };
  assert.equal(createWorkSnapshot(first), createWorkSnapshot(reordered));
  assert.notEqual(createWorkSnapshot(first), createWorkSnapshot({ ...first, rootEntries: [...first.rootEntries].reverse() }));
  assert.notEqual(createWorkSnapshot(first), createWorkSnapshot({ ...first, packMetadata: { ...first.packMetadata, version: 2 } }));
});
