// Après un enregistrement réussi, le projet rangé par l'écriture (image copiée
// dans `images-generees/`, séparateurs mixtes) ne doit pas faire croire qu'il
// reste du travail : la signature publiée porte sur le projet tel que le store
// l'installe, c'est-à-dire normalisé.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useSaveProgress } = await import('../src/hooks/useSaveProgress.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { hasUnsavedWork } = await import('../src/store/projectHelpers.js');
const { normalizeProjectData } = await import('../src/store/projectModel.js');

const noop = () => {};
const ref = (current) => ({ current });

test('projet rangé par l’écriture : le travail publié est déclaré enregistré', async () => {
  const harness = await createDiskHarness();
  try {
    const storeRunner = runner(() => useProjectStore());
    let store = storeRunner.render();
    // Image temporaire réelle : l'écriture la range dans `images-generees/`.
    const image = await harness.writeFile('story_studio_images/x.png', 'png');
    const project = normalizeProjectData({
      projectType: 'pack',
      projectName: 'Avant',
      rootEntries: [{ id: 'C', type: 'story', name: 'C', itemImage: image }],
    });
    store.loadProject(project);
    store.setSavePath(harness.dir('rangement.mbah'));
    store = storeRunner.render();
    const refs = {
      mediaLibraryPathsRef: ref([]),
      savedSnapshotRef: ref(null),
      autoSaveSnapshotRef: ref(null),
      isSavingRef: ref(false),
    };
    const savesRunner = runner(() => useSaveProgress({
      ...refs,
      store,
      configuredWorkspaceDir: harness.workspace,
      useWorkspaceForNewProjects: true,
      setMediaLibraryPaths: noop,
      autoSaveEnabled: false,
      autoSaveBackupLimit: 0,
      setSaveToast: noop,
      setRecentProjects: noop,
      maybeOfferTransferIntoProject: async (p) => ({ project: p, changed: false }),
    }));
    const api = savesRunner.render();
    await api.persistProjectSnapshot(store.project, store.savePath);
    store = storeRunner.render();
    assert.match(store.project.rootEntries[0].itemImage, /images-generees/);
    assert.equal(hasUnsavedWork({
      project: store.project,
      mediaLibraryPaths: refs.mediaLibraryPathsRef.current,
      mediaTags: store.mediaTags,
      savedSnapshot: refs.savedSnapshotRef.current,
    }), false);
  } finally {
    await harness.dispose();
  }
});
