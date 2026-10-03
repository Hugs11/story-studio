import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);

const { useProjectStore } = await import('../src/store/projectStore.js');
const {
  createAdvancedProject,
  withEditorState,
} = await import('../src/store/projectModel/authoring.js');
const { normalizeProjectData } = await import('../src/store/projectModel/schema.js');

const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';

test('cinq Ctrl+Z puis cinq rétablissements restent exacts sous la double exécution stricte', () => {
  const hook = runner(() => useProjectStore(), { doubleInvokeStateUpdaters: true });
  let store = hook.render();
  store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName: 'historique strict' }));
  store = hook.render();
  const initial = JSON.stringify(store.project);

  for (let version = 1; version <= 5; version += 1) {
    store.setProject((project) => withEditorState(project, { version }));
    store = hook.render();
  }
  const final = JSON.stringify(store.project);
  assert.equal(store.canUndo, true);

  for (let count = 0; count < 5; count += 1) {
    store.undo();
    store = hook.render();
  }
  assert.equal(JSON.stringify(store.project), initial);
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, true);

  for (let count = 0; count < 5; count += 1) {
    store.redo();
    store = hook.render();
  }
  assert.equal(JSON.stringify(store.project), final);
  assert.equal(store.canUndo, true);
  assert.equal(store.canRedo, false);
});

test('le type initial et son identité ne créent aucune étape d’historique', () => {
  const hook = runner(() => useProjectStore(), { doubleInvokeStateUpdaters: true });
  let store = hook.render();

  store.resetProject();
  store.setProjectType('pack');
  store = hook.render();

  assert.equal(store.project.projectType, 'pack');
  assert.match(store.project.packMetadata.uuid, /\S/);
  assert.equal(store.canUndo, false);
  store.undo();
  store = hook.render();
  assert.equal(store.project.projectType, 'pack');
});

test('ajout et collage gardés par la profondeur produisent chacun une seule étape exacte', () => {
  const hook = runner(() => useProjectStore(), { doubleInvokeStateUpdaters: true });
  let store = hook.render();
  store.loadProject(normalizeProjectData({ projectType: 'pack', rootEntries: [] }));
  store = hook.render();

  store.addMenu();
  store = hook.render();
  assert.equal(store.project.rootEntries.length, 1);
  const copied = structuredClone(store.project.rootEntries[0]);

  store.pasteEntriesToMenu(null, [copied]);
  store = hook.render();
  assert.equal(store.project.rootEntries.length, 2);

  store.undo();
  store = hook.render();
  assert.equal(store.project.rootEntries.length, 1, 'le premier undo retire le collage');
  store.undo();
  store = hook.render();
  assert.equal(store.project.rootEntries.length, 0, 'le second undo retire la création');

  store.redo();
  store = hook.render();
  assert.equal(store.project.rootEntries.length, 1);
  store.redo();
  store = hook.render();
  assert.equal(store.project.rootEntries.length, 2);
});
