import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);
const { useMissingMediaRelink } = await import('../src/hooks/useMissingMediaRelink.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { createAdvancedProject, withMediaBindings } = await import('../src/store/projectModel/authoring.js');
const { readMediaBindings } = await import('../src/store/projectModel/mediaBindings.js');
const { shouldProposeMissingMediaRelink } = await import('../src/store/missingMediaRelink.js');
const { mediaTagsFor } = await import('../src/store/mediaTags.js');
const { pathKey } = await import('../src/utils/fileUtils.js');

function harness(t, acceptedSteps, { sharedPath = false, free = false, windowsAliases = false } = {}) {
  const oldA = windowsAliases ? 'C:\\ANCIEN\\A.WAV' : '/ancien/a.wav';
  const oldB = sharedPath ? (windowsAliases ? 'c:/ancien/a.wav' : oldA) : '/ancien/b.wav';
  const newA = windowsAliases ? 'C:/Nouveau/a.wav' : '/nouveau/a.wav';
  const newB = '/nouveau/b.wav';
  const bindings = [
    { assetRef: 'a.wav', path: oldA, status: 'missing' },
    { assetRef: 'b.wav', path: oldB, status: 'missing' },
  ];
  const initial = free
    ? { projectType: 'pack', rootAudio: oldA, rootEntries: [{ id: 'b', type: 'story', audio: oldB }] }
    : createAdvancedProject({
        payload: '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]}}', mediaBindings: bindings,
      });
  const app = runner(() => useProjectStore());
  let store = app.render();
  store.loadProject(initial);
  const originalTags = windowsAliases
    ? { 'C:/Ancien/a.wav': ['commun'], 'c:\\ancien\\A.wav': ['autre'] }
    : sharedPath ? { [oldA]: ['commun'] } : { [oldA]: ['A'], [oldB]: ['B'] };
  const originalLibrary = sharedPath ? [oldA] : [oldA, oldB];
  store.setMediaTags(originalTags);
  store = app.render();
  const library = { current: [...originalLibrary] };
  const saves = [];
  let gestureCalls = 0;
  const advancedAuthoring = {
    async runGesture(gesture) {
      gestureCalls += 1;
      if (gestureCalls > acceptedSteps) return { status: 'refused' };
      const next = withMediaBindings(store.project, readMediaBindings(store.project).map((binding) => (
        binding.assetRef === gesture.assetRef
          ? { ...binding, path: gesture.location.path, status: 'resolved' }
          : binding
      )));
      store.setProject(next);
      store = app.render();
      return { status: 'applied', project: store.project };
    },
  };
  const pathAudit = { [oldA]: false, [oldB]: false, [newA]: true, [newB]: true };
  const hook = runner(() => useMissingMediaRelink({
    store, advancedAuthoring, mediaLibraryPathsRef: library,
    setMediaLibraryPaths: (paths) => { library.current = paths; }, pathAudit,
    handleSaveProject: async (overrides) => { saves.push(overrides); },
  }));
  hook.render();
  hook.flush();
  t.after(() => { hook.unmount(); app.unmount(); });
  return {
    oldA, oldB, newA, newB, originalTags, originalLibrary, library, saves,
    async apply() {
      const replacements = sharedPath ? new Map([[oldA, newA]]) : { [oldA]: newA, [oldB]: newB };
      await hook.render().handleApplyMissingMediaRelinks(replacements, { saveAfter: true });
      store = app.render();
      return { store, api: hook.render(), gestureCalls };
    },
    propose(api) {
      return shouldProposeMissingMediaRelink({
        projectOpen: true, savePath: '/travail/projet.mbah', ...api,
      });
    },
  };
}

for (const acceptedSteps of [1, 0, 2]) {
  test(`relink graphe : ${acceptedSteps} geste(s) appliqué(s), métadonnées et sauvegarde cohérentes`, async (t) => {
    const f = harness(t, acceptedSteps);
    const { store, api, gestureCalls } = await f.apply();
    const expectedTags = {
      [acceptedSteps > 0 ? f.newA : f.oldA]: ['A'],
      [acceptedSteps > 1 ? f.newB : f.oldB]: ['B'],
    };
    const expectedLibrary = [acceptedSteps > 0 ? f.newA : f.oldA, acceptedSteps > 1 ? f.newB : f.oldB];
    assert.deepEqual(store.mediaTags, expectedTags);
    assert.deepEqual(f.library.current, expectedLibrary);
    assert.deepEqual(readMediaBindings(store.project).map((binding) => binding.path), expectedLibrary);
    assert.equal(gestureCalls, Math.min(acceptedSteps + 1, 2));
    assert.equal(f.propose(api), acceptedSteps < 2, 'le refus reste proposable');
    if (acceptedSteps === 0) assert.deepEqual(f.saves, []);
    else assert.deepEqual(f.saves, [{
      projectOverride: store.project, mediaTagsOverride: expectedTags, mediaLibraryPathsOverride: expectedLibrary,
    }]);
  });
}

test('relink partiel de deux références au même fichier : tags et catalogue gardent le média refusé', async (t) => {
  const f = harness(t, 1, { sharedPath: true });
  const { store, api } = await f.apply();
  assert.deepEqual(readMediaBindings(store.project).map((binding) => binding.path), [f.newA, f.oldA]);
  assert.deepEqual(store.mediaTags, { [f.newA]: ['commun'], [f.oldA]: ['commun'] });
  assert.deepEqual(new Set(f.library.current), new Set([f.newA, f.oldA]));
  assert.equal(f.propose(api), true);
  assert.deepEqual(f.saves[0], {
    projectOverride: store.project, mediaTagsOverride: store.mediaTags, mediaLibraryPathsOverride: f.library.current,
  });
});

test('le relink par menus conserve sa mise à jour atomique et ses arguments de sauvegarde', async (t) => {
  const f = harness(t, 0, { free: true });
  const { store, api, gestureCalls } = await f.apply();
  assert.equal(gestureCalls, 0);
  assert.equal(store.project.rootAudio, f.newA);
  assert.equal(store.project.rootEntries[0].audio, f.newB);
  assert.deepEqual(store.mediaTags, { [f.newA]: ['A'], [f.newB]: ['B'] });
  assert.deepEqual(f.library.current, [f.newA, f.newB]);
  assert.equal(f.propose(api), false);
  assert.deepEqual(f.saves[0], {
    projectOverride: store.project, mediaTagsOverride: store.mediaTags, mediaLibraryPathsOverride: f.library.current,
  });
});

test('relink partiel Windows : les alias gardent toutes les étiquettes sans clés dupliquées', async (t) => {
  const f = harness(t, 1, { sharedPath: true, windowsAliases: true });
  const { store, api } = await f.apply();
  assert.deepEqual(readMediaBindings(store.project).map((binding) => binding.path), [f.newA, f.oldB]);
  assert.deepEqual(mediaTagsFor(store.mediaTags, f.oldB), ['commun', 'autre']);
  assert.deepEqual(mediaTagsFor(store.mediaTags, f.newA), ['commun', 'autre']);
  assert.equal(Object.keys(store.mediaTags).length, 2, 'une clé par fichier, même avec plusieurs alias Windows');
  assert.deepEqual(new Set(f.library.current.map(pathKey)), new Set([f.newA, f.oldA].map(pathKey)));
  assert.equal(f.propose(api), true);
  assert.deepEqual(f.saves[0], {
    projectOverride: store.project, mediaTagsOverride: store.mediaTags, mediaLibraryPathsOverride: f.library.current,
  });
});
