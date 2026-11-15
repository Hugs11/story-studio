import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useMediaTransferHandlers } = await import('../src/hooks/useMediaTransferHandlers.js');
const { normalizeProjectData, findEntryById } = await import('../src/store/projectModel.js');
const noop = () => {};

// Forme stockée par le modèle sous Windows comme ailleurs : aucune lettre de lecteur.
const JINGLE = '/sons/jingle.mp3';

function mounted() {
  let store; let transfers;
  const app = runner(() => {
    store = useProjectStore();
    transfers = useMediaTransferHandlers({
      store, sessionModeRef: { current: 'project' }, copyImportedFilesEnabled: false,
      workspaceDir: null, workspaceDirRef: { current: null }, savePathRef: { current: null },
      setWorkspaceDirState: noop, setSaveToast: noop, addPathsToMediaLibrary: noop,
    });
  });
  app.render();
  store.loadProject(normalizeProjectData({
    projectType: 'pack', projectName: 'Jingles',
    packMetadata: { uuid: '99999999-9999-4999-8999-999999999999' },
    rootEntries: [
      { id: 'a', type: 'story', name: 'A', audio: '/sons/a.mp3', itemAudio: JINGLE },
      { id: 'b', type: 'story', name: 'B', audio: '/sons/b.mp3', itemAudio: JINGLE },
      { id: 'c', type: 'story', name: 'C', audio: null },
    ],
  }));
  app.render();
  return { app, read: () => { app.render(); return { store, transfers }; } };
}

test('déplacer (couper-coller) le son d’un écran ne le retire pas d’un autre écran qui l’emploie', async () => {
  const { read } = mounted();
  const { transfers } = read();
  // Arbre : « Couper » le son de titre de A, puis « Coller le son » sur C
  // (`useTreeClipboard.handlePasteMedia` → `dropOnNode`, mode « cut »).
  await transfers.dropOnNode({ nodeId: 'c', nodeType: 'story', path: JINGLE, paths: [JINGLE], kind: 'audio', clipboardMode: 'cut', source: { kind: 'story', entryId: 'a', field: 'itemAudio' } });
  const { store } = read();
  assert.equal(findEntryById(store.project, 'c').audio, JINGLE, 'le son arrive sur C');
  assert.equal(findEntryById(store.project, 'b').itemAudio, JINGLE, 'B, qui employait le même son, le garde');
});

test('même défaut par le champ son de l’inspecteur (`notifyCutPaste`)', () => {
  const { read } = mounted();
  const { transfers } = read();
  transfers.notifyCutPaste({ path: JINGLE, kind: 'audio', source: { kind: 'story', entryId: 'a', field: 'itemAudio' } });
  const { store } = read();
  assert.equal(findEntryById(store.project, 'b').itemAudio, JINGLE, 'B garde son son');
});


test('la coupe retire uniquement le champ source', async () => {
  const { read } = mounted();
  const { transfers } = read();
  await transfers.dropOnNode({ nodeId: 'c', nodeType: 'story', path: JINGLE, kind: 'audio', clipboardMode: 'cut', source: { kind: 'story', entryId: 'a', field: 'itemAudio' } });
  const { store } = read();
  assert.equal(findEntryById(store.project, 'a').itemAudio, null);
  assert.equal(findEntryById(store.project, 'a').audio, '/sons/a.mp3');
});

test('une coupe de médiathèque ne retire aucun emploi existant', async () => {
  const { read } = mounted();
  await read().transfers.dropOnNode({ nodeId: 'c', nodeType: 'story', path: JINGLE, kind: 'audio', clipboardMode: 'cut' });
  const { store } = read();
  assert.equal(findEntryById(store.project, 'a').itemAudio, JINGLE);
  assert.equal(findEntryById(store.project, 'b').itemAudio, JINGLE);
  assert.equal(findEntryById(store.project, 'c').audio, JINGLE);
});

test('recoller dans le champ source le conserve', () => {
  const { read } = mounted();
  const { store, transfers } = read();
  const source = { kind: 'story', entryId: 'a', field: 'itemAudio' };
  store.updateItem('a', { itemAudio: JINGLE });
  transfers.notifyCutPaste({ path: JINGLE, source, target: source });
  assert.equal(findEntryById(read().store.project, 'a').itemAudio, JINGLE);
});

test('un collage refusé sur la racine simple conserve le champ coupé', async () => {
  const { read } = mounted();
  const { store } = read();
  store.loadProject(normalizeProjectData({ projectType: 'simple', rootEntries: [{ id: 'a', type: 'story', audio: '/sons/a.mp3', itemAudio: JINGLE }] }));
  await read().transfers.dropOnNode({ nodeId: 'root', nodeType: 'root', path: JINGLE, kind: 'audio', clipboardMode: 'cut', source: { kind: 'story', entryId: 'a', field: 'itemAudio' } });
  assert.equal(findEntryById(read().store.project, 'a').itemAudio, JINGLE);
});

const { clearMediaField } = await import('../src/store/projectModel.js');
const { audioClipboard, imageClipboard } = await import('../src/store/fieldClipboard.js');

test('le presse-papiers conserve la cible de coupe, et la copie ou la médiathèque l’efface', () => {
  const source = { kind: 'story', entryId: 'a', field: 'itemAudio' };
  for (const clipboard of [audioClipboard, imageClipboard]) {
    clipboard.set(JINGLE, { mode: 'cut', source });
    assert.deepEqual(clipboard.getEntry().source, source);
    clipboard.set(JINGLE);
    assert.equal(clipboard.getEntry().source, null);
    clipboard.set([JINGLE], { mode: 'cut' });
    assert.equal(clipboard.getEntry().source, null);
    clipboard.clear();
  }
});

test('couper la couverture partagée préserve la vignette et les autres écrans', () => {
  const project = normalizeProjectData({ projectType: 'pack', rootImage: '/commun.png', thumbnailImage: '/commun.png', rootEntries: [{ id: 'a', type: 'story', itemImage: '/commun.png' }] });
  const next = clearMediaField(project, { kind: 'root', field: 'rootImage' }, '/commun.png');
  assert.equal(next.rootImage, null);
  assert.equal(next.thumbnailImage, '/commun.png');
  assert.equal(findEntryById(next, 'a').itemImage, '/commun.png');
});

test('la coupe d’une étape retrouve son identifiant après réordonnancement et conserve les autres réglages', () => {
  const project = normalizeProjectData({ projectType: 'pack', rootEntries: [{ id: 'a', type: 'story', afterPlaybackSequence: [{ id: 'second', audio: JINGLE }, { id: 'first', name: 'Titre modifi?', audio: JINGLE }], afterPlaybackHomeStep: { id: 'home', audio: JINGLE, image: '/commun.png' } }] });
  const source = { kind: 'storySequence', entryId: 'a', stepId: 'first', field: 'audio' };
  const next = clearMediaField(project, source, JINGLE);
  const story = findEntryById(next, 'a');
  assert.equal(story.afterPlaybackSequence[0].audio, JINGLE);
  assert.equal(story.afterPlaybackSequence[1].audio, null);
  assert.equal(story.afterPlaybackSequence[1].name, 'Titre modifi?');
  const clearedHome = clearMediaField(next, { kind: 'storyHomeStep', entryId: 'a', field: 'image' }, '/commun.png');
  assert.equal(findEntryById(clearedHome, 'a').afterPlaybackHomeStep.image, null);
  assert.equal(findEntryById(clearedHome, 'a').afterPlaybackHomeStep.audio, JINGLE);
});

test('un champ remplacé depuis la coupe conserve son nouveau média', () => {
  const project = normalizeProjectData({ projectType: 'pack', rootEntries: [{ id: 'a', type: 'story', itemAudio: '/sons/nouveau.mp3' }] });
  assert.equal(clearMediaField(project, { kind: 'story', entryId: 'a', field: 'itemAudio' }, JINGLE), project);
});
