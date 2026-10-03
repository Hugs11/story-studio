// Éditeur simplifié : un son déposé sur le panneau de gauche, ou sur le nœud
// racine (arbre ou diagramme), devient l'« Audio du récit » de l'unique
// histoire s'il est vide ; sinon le dépôt est refusé avec un message clair.
// Jamais de seconde histoire.
//
// Les hooks `useImportSession` et `useMediaTransferHandlers` et le vrai store
// sont exécutés intacts ; seuls l'ordonnanceur React et les services de copie
// et de lecture des médias sont doublés.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { normalizeProjectData, buildProjectIndex } = await import('../src/store/projectModel.js');

const noop = () => {};

function simpleProject(audio = null) {
  return normalizeProjectData({
    projectType: 'simple',
    projectName: 'Simple',
    rootAudio: 'C:/m/titre.mp3',
    rootImage: 'C:/m/titre.png',
    rootEntries: [{ id: 'unique', type: 'story', name: '', audio }],
  });
}

function mount(initialProject, { isImportedPackPath = () => false } = {}) {
  let store; let session; let transfer;
  const app = runner(() => {
    store = useProjectStore();
    transfer = useMediaTransferHandlers({
      store,
      copyImportedFilesEnabled: false,
      setCopyImportedFilesEnabled: noop,
      workspaceDir: 'C:/ws',
      setWorkspaceDirState: noop,
      workspaceDirRef: { current: 'C:/ws' },
      savePathRef: { current: null },
      pathAudit: null,
      dismissedTransferPromptRef: { current: null },
      setSaveToast: noop,
      persistProjectSnapshotRef: { current: null },
      showErrorDialog: noop,
      addPathsToMediaLibrary: noop,
    });
    session = useImportSession({
      store,
      projectIndex: buildProjectIndex(store.project),
      maybeCopyToProject: async (path) => path,
      extractAudioEmbeddedImage: async () => 'C:/m/pochette.png',
      setImporting: noop,
      setUnpacking: noop,
      setImportNotice: noop,
      persistProjectSnapshot: async () => null,
      workspaceDirRef: { current: 'C:/ws' },
      showErrorDialog: noop,
      getImportDisplayName: (path) => path,
      isImportedPackPath,
      onImportedPackPromoted: noop,
    });
  });
  app.render();
  store.loadProject(initialProject);
  app.render();
  return {
    get store() { return store; },
    get session() { return session; },
    get transfer() { return transfer; },
    render: () => app.render(),
  };
}

function stories(c) {
  return c.store.project.rootEntries.map(({ id, audio }) => ({ id, audio: audio?.replaceAll('\\', '/') ?? null }));
}

const drops = {
  'le panneau de gauche': (c, path) => c.session.dispatchFiles(null, [path]),
  'le nœud racine': (c, path) => c.transfer.dropOnNode({ nodeId: 'root', nodeType: 'root', path, kind: 'audio' }),
};

for (const [where, drop] of Object.entries(drops)) {
  test(`un son déposé sur ${where} devient l’Audio du récit de l’unique histoire`, async () => {
    const c = mount(simpleProject());
    await drop(c, 'C:/m/mon-histoire.mp3');
    c.render();
    assert.deepEqual(stories(c), [{ id: 'unique', audio: 'C:/m/mon-histoire.mp3' }]);
    assert.equal(c.store.mutationError, null);
  });

  test(`sur ${where}, un récit déjà posé refuse le dépôt avec un message clair`, async () => {
    const c = mount(simpleProject('C:/m/deja.mp3'));
    await drop(c, 'C:/m/mon-histoire.mp3');
    c.render();
    assert.deepEqual(stories(c), [{ id: 'unique', audio: 'C:/m/deja.mp3' }]);
    assert.match(c.store.mutationError?.message ?? '', /Audio du récit/);
  });
}

test('un projet par menus garde l’ajout d’une histoire par dépôt', async () => {
  const c = mount(normalizeProjectData({ ...simpleProject(), projectType: 'pack' }));
  await c.session.dispatchFiles(null, ['C:/m/mon-histoire.mp3']);
  c.render();
  assert.equal(c.store.project.rootEntries.length, 2);
});

// C2b : un pack (.zip) déposé dans un projet simple ne devient pas une seconde
// entrée racine, invisible dans l'éditeur simplifié : le dépôt est refusé.

const isZip = (path) => path.endsWith('.zip');

async function packReader() {
  return createDiskHarness({
    commands: { load_pack_zip: () => JSON.stringify({ title: 'Pack déposé', stageNodes: [] }) },
  });
}

test('C2b : un .zip déposé dans un projet simple est refusé avec un message clair', async (t) => {
  const disk = await packReader();
  t.after(() => disk.dispose());
  const c = mount(simpleProject('C:/m/deja.mp3'), { isImportedPackPath: isZip });
  await c.session.dispatchFiles(null, ['C:/m/pack.zip']);
  c.render();
  assert.deepEqual(stories(c), [{ id: 'unique', audio: 'C:/m/deja.mp3' }]);
  assert.match(c.store.mutationError?.message ?? '', /projet simple/);
});

test('témoin : un projet par menus garde l’ajout d’un .zip déposé', async (t) => {
  const disk = await packReader();
  t.after(() => disk.dispose());
  const c = mount(normalizeProjectData({ ...simpleProject(), projectType: 'pack' }), { isImportedPackPath: isZip });
  await c.session.dispatchFiles(null, ['C:/m/pack.zip']);
  c.render();
  assert.deepEqual(c.store.project.rootEntries.map((entry) => entry.type), ['story', 'zip']);
  assert.equal(c.store.mutationError, null);
});
