// Reliaison : une liaison média qu'aucun Écran n'emploie plus.
//
// Aucun geste ne retire une liaison (`native_pack/editing/media.rs`) : remplacer
// ou retirer le son d'un Écran laisse l'ancienne liaison dans le projet, pour
// toujours. Si ce fichier disparaît ensuite du disque, « Médias introuvables »
// le propose à chaque ouverture, et relier échoue : `repoint-media` refuse une
// référence qu'aucun Écran ne cite (`UNKNOWN_ASSET_REF`), ce qui arrête
// la série avant les liaisons réellement utilisées.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);
const { useMissingMediaRelink } = await import('../src/hooks/useMissingMediaRelink.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { createAdvancedProject, withMediaBindings } = await import('../src/store/projectModel/authoring.js');
const { readMediaBindings } = await import('../src/store/projectModel/mediaBindings.js');
const { collectMissingMedia, planAdvancedRelink } = await import('../src/store/missingMediaRelink.js');

const OLD_UNUSED = '/ancien/essai-abandonne.mp3';
const OLD_USED = '/ancien/histoire.mp3';
const NEW_UNUSED = '/nouveau/essai-abandonne.mp3';
const NEW_USED = '/nouveau/histoire.mp3';
// Seule `histoire.mp3` est citée par un Écran du document.
const REFERENCED = new Set(['histoire.mp3']);

function project() {
  return createAdvancedProject({
    payload: '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]}}',
    mediaBindings: [
      { assetRef: 'essai-abandonne.mp3', path: OLD_UNUSED, status: 'missing' },
      { assetRef: 'histoire.mp3', path: OLD_USED, status: 'missing' },
    ],
  });
}

test('relier les médias introuvables relie le son utilisé, même si une liaison inutilisée manque aussi', async (t) => {
  const app = runner(() => useProjectStore());
  let store = app.render();
  store.loadProject(project());
  store = app.render();
  const library = { current: [] };
  // Double fidèle à la règle Rust : `repoint-media` refuse une référence
  // qu'aucun Écran ne cite.
  const advancedAuthoring = {
    async runGesture(gesture) {
      if (!REFERENCED.has(gesture.assetRef)) return { status: 'refused', error: { code: 'UNKNOWN_ASSET_REF' } };
      store.setProject(withMediaBindings(store.project, readMediaBindings(store.project).map((binding) => (
        binding.assetRef === gesture.assetRef
          ? { ...binding, path: gesture.location.path, status: 'resolved' }
          : binding
      ))));
      store = app.render();
      return { status: 'applied', project: store.project };
    },
  };
  const hook = runner(() => useMissingMediaRelink({
    store, advancedAuthoring, mediaLibraryPathsRef: library,
    advancedMediaUsages: [...REFERENCED].map((assetRef) => ({ assetRef })),
    setMediaLibraryPaths: (paths) => { library.current = paths; },
    pathAudit: { [OLD_UNUSED]: false, [OLD_USED]: false, [NEW_UNUSED]: true, [NEW_USED]: true },
    handleSaveProject: async () => {},
  }));
  hook.render();
  hook.flush();
  t.after(() => { hook.unmount(); app.unmount(); });

  await hook.render().handleApplyMissingMediaRelinks({ [OLD_UNUSED]: NEW_UNUSED, [OLD_USED]: NEW_USED });
  store = app.render();
  const used = readMediaBindings(store.project).find((binding) => binding.assetRef === 'histoire.mp3');
  assert.equal(used.path, NEW_USED, 'le son utilisé par un Écran doit être relié');
  const unused = readMediaBindings(store.project).find((binding) => binding.assetRef === 'essai-abandonne.mp3');
  assert.equal(unused.path, OLD_UNUSED, 'la liaison inutilisée reste dans le projet, sans être repointée');
});

test('un fichier qu\'aucun Écran n\'emploie n\'est pas annoncé introuvable', () => {
  const missing = collectMissingMedia(project(), { [OLD_UNUSED]: false, [OLD_USED]: true }, REFERENCED);
  assert.deepEqual(missing.map((item) => item.path), [], 'la boîte « Médias introuvables » ne devrait pas s\'ouvrir pour un fichier inutilisé');
});

test('le plan ignore une liaison inutilisée même si elle partage le chemin employé', () => {
  const initial = project();
  initial.authoring.mediaBindings[0].path = OLD_USED;
  assert.deepEqual(planAdvancedRelink(initial, { [OLD_USED]: NEW_USED }, REFERENCED), [
    { assetRef: 'histoire.mp3', path: NEW_USED, previousPath: OLD_USED },
  ]);
  assert.equal(readMediaBindings(initial)[0].path, OLD_USED);
});
