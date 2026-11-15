// Les saisies de nom restent immédiates sans saturer l'historique.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useProjectMutations } = await import('../src/hooks/useProjectMutations.js');
const { normalizeProjectData, findEntryById } = await import('../src/store/projectModel.js');

function loaded() {
  const storeRunner = runner(() => useProjectStore());
  let store = storeRunner.render();
  store.loadProject(normalizeProjectData({
    projectType: 'pack', projectName: 'Recueil',
    packMetadata: { uuid: '88888888-8888-4888-8888-888888888888' },
    rootEntries: [
      { id: 'dossier', type: 'menu', name: 'Contes du soir', children: [
        { id: 'conte', type: 'story', name: 'Conte', audio: 'C:/sons/conte.mp3' },
      ] },
      { id: 'histoire', type: 'story', name: '', audio: 'C:/sons/histoire.mp3' },
    ],
  }));
  store = storeRunner.render();
  return { storeRunner, store };
}

// Ce que fait `StoryEditor` : `onChange={(e) => onUpdate({ name: e.target.value })}`.
function typeName(store, storeRunner, id, text) {
  for (let length = 1; length <= text.length; length += 1) {
    store.updateItem(id, { name: text.slice(0, length) });
    store = storeRunner.render();
  }
  return store;
}

const TITLE = 'Le petit ours qui ne voulait pas dormir sans son doudou';

test('un dossier supprimé reste récupérable après la saisie d’un titre', () => {
  let { storeRunner, store } = loaded();
  store.deleteMenu('dossier');
  store = storeRunner.render();
  assert.equal(findEntryById(store.project, 'dossier'), null);

  store = typeName(store, storeRunner, 'histoire', TITLE);
  assert.equal(findEntryById(store.project, 'histoire').name, TITLE);

  // L'auteur s'aperçoit de la suppression et annule autant qu'il le faut.
  for (let step = 0; step < 200 && store.canUndo; step += 1) {
    store.undo();
    store = storeRunner.render();
  }
  assert.ok(findEntryById(store.project, 'dossier'), 'le dossier supprimé avant la saisie revient');
});

test('« Annuler » après la saisie d’un titre ne retire pas une seule lettre', () => {
  let { storeRunner, store } = loaded();
  store = typeName(store, storeRunner, 'histoire', TITLE);
  store.undo();
  store = storeRunner.render();
  assert.notEqual(findEntryById(store.project, 'histoire').name, TITLE.slice(0, -1));
});

test('deux champs différents du même élément font deux étapes', () => {
  const { storeRunner, store } = loaded();
  const { handleUpdateRoot } = runner(() => useProjectMutations({ store })).render();
  const initial = store.project;
  handleUpdateRoot({ rootName: 'R' });
  handleUpdateRoot({ rootName: 'Racine' });
  handleUpdateRoot({ endNodeName: 'F' });
  handleUpdateRoot({ endNodeName: 'Fin' });
  store.undo();
  let current = storeRunner.render();
  assert.equal(current.project.rootName, 'Racine');
  assert.equal(current.project.endNodeName, initial.endNodeName);
  current.undo();
  current = storeRunner.render();
  assert.deepEqual(current.project, initial);
  assert.equal(current.canUndo, false);
});

test('Annuler puis retaper crée une nouvelle étape et vide Rétablir', () => {
  let { storeRunner, store } = loaded();
  const initial = store.project;
  store.deleteMenu('dossier');
  store = typeName(store, storeRunner, 'histoire', TITLE);
  store.undo();
  store = storeRunner.render();
  store = typeName(store, storeRunner, 'histoire', 'Autre titre');
  assert.equal(store.canRedo, false);
  store.undo();
  store = storeRunner.render();
  assert.equal(findEntryById(store.project, 'histoire').name, '');
  assert.equal(findEntryById(store.project, 'dossier'), null);
  store.undo();
  assert.deepEqual(storeRunner.render().project, initial);
});

test('consulter un autre élément sépare deux saisies sur le même élément', () => {
  let { storeRunner, store } = loaded();
  store.setSelectedId('histoire');
  store = storeRunner.render();
  store = typeName(store, storeRunner, 'histoire', 'Premier');
  store.setSelectedId('conte');
  store = storeRunner.render();
  store.setSelectedId('histoire');
  store = storeRunner.render();
  store = typeName(store, storeRunner, 'histoire', 'Premier corrigé');

  store.undo();
  store = storeRunner.render();
  assert.equal(findEntryById(store.project, 'histoire').name, 'Premier');
  store.undo();
  store = storeRunner.render();
  assert.equal(findEntryById(store.project, 'histoire').name, '');
  assert.equal(store.canUndo, false);
});

test('deux éléments différents font deux étapes', () => {
  let { storeRunner, store } = loaded();
  store = typeName(store, storeRunner, 'histoire', 'Premier');
  store = typeName(store, storeRunner, 'conte', 'Second');
  store.undo();
  store = storeRunner.render();
  assert.equal(findEntryById(store.project, 'conte').name, 'Conte');
  assert.equal(findEntryById(store.project, 'histoire').name, 'Premier');
  store.undo();
  store = storeRunner.render();
  assert.equal(findEntryById(store.project, 'histoire').name, '');
  assert.equal(store.canUndo, false);
});

for (const [label, interrupt] of [
  ['une autre mutation', store => store.updateItem('histoire', { audio: 'C:/autre.mp3' })],
  ['un enregistrement', store => store.setSavePath('C:/recueil.mbah')],
  ['un renommage validé dans l’arbre', store => store.updateItem('histoire', { name: 'Arbre' }, { historyGroup: null })],
]) {
  test(`${label} rompt le regroupement`, () => {
    let { storeRunner, store } = loaded();
    store = typeName(store, storeRunner, 'histoire', 'Avant');
    interrupt(store);
    const beforeTyping = storeRunner.render().project;
    store = typeName(store, storeRunner, 'histoire', 'Après');
    store.undo();
    store = storeRunner.render();
    assert.deepEqual(store.project, beforeTyping);
    assert.equal(store.canUndo, true);
  });
}

test('changer de projet rompt le regroupement même avec les mêmes identifiants', () => {
  let { storeRunner, store } = loaded();
  const initial = store.project;
  store = typeName(store, storeRunner, 'histoire', 'Premier projet');
  store.loadProject(initial);
  store = typeName(store, storeRunner, 'histoire', 'Second projet');
  store.undo();
  store = storeRunner.render();
  assert.deepEqual(store.project, initial);
  assert.equal(store.canUndo, false);
});

test('un projet simple met à jour nom et titre en direct dans une seule étape', () => {
  const hook = runner(() => {
    const store = useProjectStore();
    return { store, mutations: useProjectMutations({ store }) };
  }, { doubleInvokeStateUpdaters: true });
  let current = hook.render();
  current.store.setProjectType('simple');
  current = hook.render();
  const initial = current.store.project;
  for (let length = 1; length <= TITLE.length; length += 1) {
    const name = TITLE.slice(0, length);
    current.mutations.handleUpdateRoot({ projectName: name, packMetadata: { title: name } });
    current = hook.render();
    assert.equal(current.store.project.projectName, name.trim());
    assert.equal(current.store.project.packMetadata.title, name.trim());
  }
  current.store.undo();
  current = hook.render();
  assert.deepEqual(current.store.project, initial);
  assert.equal(current.store.canUndo, false);
  current.store.redo();
  current = hook.render();
  assert.equal(current.store.project.projectName, TITLE);
  current.mutations.handleUpdateRoot({ projectName: 'Après rétablissement', packMetadata: { title: 'Après rétablissement' } });
  current.store.undo();
  assert.equal(hook.render().store.project.projectName, TITLE);
});

for (const type of ['menu', 'zip']) {
  test(`les frappes du nom d’un ${type} forment une étape`, () => {
    const { storeRunner, store } = loaded();
    store.loadProject(normalizeProjectData({
      projectType: 'pack', rootEntries: [{ id: 'entry', type, name: 'Initial', children: [] }],
    }));
    const initial = storeRunner.render().project;
    const update = type === 'menu' ? store.updateMenu : store.updateItem;
    update('entry', { name: 'N' });
    update('entry', { name: 'Nouveau' });
    store.undo();
    const current = storeRunner.render();
    assert.deepEqual(current.project, initial);
    assert.equal(current.canUndo, false);
  });
}
