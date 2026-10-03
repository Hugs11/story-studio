// Coller un Dossier coupé dans lui-même ou dans l'un de ses sous-dossiers.
//
// Le refus existait, mais muet : seul le refus de profondeur posait un message,
// et l'arbre comme le diagramme vidaient la coupe sans lire le verdict.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);

const { useProjectStore } = await import('../src/store/projectStore.js');
const {
  MENU_CYCLE_CODE,
  MENU_CYCLE_PASTE_MESSAGE,
  MENU_CYCLE_PASTE_TITLE,
  MENU_DEPTH_LIMIT_TITLE,
} = await import('../src/store/projectModel/menuDepth.js');
const { makeDepthProject } = await import('./fixtures/projectDepthFixtures.js');

function loaded() {
  const hook = runner(() => useProjectStore());
  const store = hook.render();
  store.loadProject(makeDepthProject(3));
  return hook;
}

test('coller un Dossier dans son sous-dossier est refusé, et le refus le dit', () => {
  const hook = loaded();
  let store = hook.render();
  const before = JSON.stringify(store.project);

  const result = store.cutPasteEntriesToMenu(['folder-1'], 'folder-2');
  store = hook.render();

  assert.equal(result.allowed, false);
  assert.equal(result.code, MENU_CYCLE_CODE);
  assert.equal(JSON.stringify(store.project), before, 'rien n’a bougé');
  assert.deepEqual(
    { code: store.mutationError?.code, title: store.mutationError?.title, message: store.mutationError?.message },
    { code: MENU_CYCLE_CODE, title: MENU_CYCLE_PASTE_TITLE, message: MENU_CYCLE_PASTE_MESSAGE },
  );
});

test('coller un Dossier sur lui-même est le même refus', () => {
  const hook = loaded();
  const result = hook.render().cutPasteEntriesToMenu(['folder-2'], 'folder-2');
  assert.equal(result.code, MENU_CYCLE_CODE);
  assert.equal(hook.render().mutationError?.code, MENU_CYCLE_CODE);
});

test('le refus de profondeur garde son propre titre', () => {
  const hook = runner(() => useProjectStore());
  hook.render().loadProject(makeDepthProject(61));
  assert.equal(hook.render().addMenu('folder-61'), null, 'niveau 62 refusé');
  assert.equal(hook.render().mutationError?.title, MENU_DEPTH_LIMIT_TITLE);
});
