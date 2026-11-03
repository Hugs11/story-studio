import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { useProjectStore } = await import('../src/store/projectStore.js');
const { createWorkSnapshot } = await import('../src/store/projectHelpers.js');
const { createAdvancedProject } = await import('../src/store/projectModel/authoring.js');
const { beginEphemeralSnapshotSeed } = await import('../src/store/ephemeralSnapshotSeed.js');
const noop = () => {};
const ref = current => ({ current });

async function withSession(run, { advanced = false } = {}) {
  let harness;
  harness = await createDiskHarness({ commands: {
    create_session_workspace: () => harness.mkdirp('session'),
    list_session_recoveries: async () => {
      const snapshotPath = harness.dir('session/.session-recovery.mbah');
      return await harness.exists(snapshotPath)
        ? [{ sessionDir: harness.dir('session'), snapshotPath }] : [];
    },
    cleanup_session_workspace: ({ path }) => fs.rm(path, { recursive: true, force: true }),
  } });
  const stores = runner(() => useProjectStore());
  let store = stores.render();
  const savedSnapshotRef = ref(null);
  let paths = [];
  let tags = {};
  const sessions = runner(() => useWorkSession({
    store, savedSnapshotRef,
    sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
    showErrorDialog: assert.fail,
    useWorkspaceForNewProjects: false, configuredWorkspaceDir: harness.workspace,
    setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop,
    workspaceDirRef: ref(harness.workspace), autoSavePathRef: ref(null),
    autoSaveSnapshotRef: ref(null), setAutoSavedPath: noop, setMediaLibraryPaths: noop,
    mediaLibraryCountRef: ref(paths.length), mediaLibraryPaths: paths, mediaTags: tags,
    currentWorkSnapshot: createWorkSnapshot(store.project, paths, tags),
    importedPackPendingMetaRef: ref(false),
  }));
  let session;
  const render = () => {
    store = stores.render();
    session = sessions.render();
    sessions.flush();
  };
  try {
    render();
    await session.prepareNewWorkSession('pack');
    if (advanced) store.loadProject(createAdvancedProject({
      payload: '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},"context":{}}',
    }));
    store.markPristine();
    render();
    await run({
      harness, savedSnapshotRef, render,
      get store() { return store; }, get session() { return session; },
      setLibrary(nextPaths, nextTags) { paths = nextPaths; tags = nextTags; render(); },
      async settle() { await session.ephemeralSnapshotSeedStateRef.current.writeChain; },
      async recoveries() {
        // Nouveau montage : l'accueil découvre le disque, sans état du hook précédent.
        const restarted = runner(() => useWorkSession({
          store, savedSnapshotRef, mediaLibraryPaths: paths, mediaTags: tags,
        }));
        restarted.render();
        restarted.flush();
        const expected = await harness.exists(harness.dir('session/.session-recovery.mbah')) ? 1 : 0;
        for (let i = 0; i < 100; i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (restarted.render().sessionRecoveries.length === expected) break;
        }
        const result = restarted.render().sessionRecoveries;
        restarted.unmount();
        return result;
      },
    });
  } finally {
    sessions.unmount();
    await harness.dispose();
  }
}

for (const advanced of [false, true]) {
  test(`session ${advanced ? 'graphe' : 'menus'} intacte : aucune reprise, même à la tick périodique`, async () => {
    await withSession(async c => {
      await c.settle();
      assert.equal(await c.harness.exists(c.harness.dir('session/.session-recovery.mbah')), false);
      assert.equal(beginEphemeralSnapshotSeed(c.session.ephemeralSnapshotSeedStateRef.current, {
        sessionMode: 'ephemeral', path: c.harness.dir('session/.session-recovery.mbah'), snapshot: 'tick',
      }), null);
      assert.deepEqual(await c.recoveries(), []);
    }, { advanced });
  });
}

test('session modifiée : reprise proposée ; annuler jusqu’à l’état initial retire la reprise', async () => {
  await withSession(async c => {
    c.store.updateProjectName('Été modifié');
    c.render();
    await c.settle();
    const recoveries = await c.recoveries();
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].projectName, 'Été modifié');
    c.store.undo();
    c.render();
    await c.settle();
    assert.deepEqual(await c.recoveries(), []);
  });
});

test('session enregistrée puis fermée : aucune reprise ; le fichier enregistré reste', async () => {
  await withSession(async c => {
    c.store.updateProjectName('Enregistré');
    c.render();
    await c.settle();
    const { saveProject } = await import('../src/store/projectIO.js');
    const path = c.harness.dir('projet.mbah');
    await saveProject(c.store.project, path);
    c.savedSnapshotRef.current = createWorkSnapshot(c.store.project, [], {});
    c.store.setSavePath(path);
    c.render();
    await c.settle();
    assert.deepEqual(await c.recoveries(), []);
    await c.session.cleanupEphemeralSession();
    c.session.resetWorkSession();
    c.render();
    assert.equal(await c.harness.exists(path), true);
    assert.deepEqual(await c.recoveries(), []);
  });
});

test('annulation pendant une écriture en vol : aucune reprise ne reste après son arrivée', async () => {
  await withSession(async c => {
    const original = window.__TAURI_INTERNALS__.invoke;
    let release;
    let entered;
    const pending = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    window.__TAURI_INTERNALS__.invoke = async (command, args, ...rest) => {
      if (command === 'plugin:fs|rename' && args.newPath.endsWith('.session-recovery.mbah')) {
        entered();
        await barrier;
      }
      return original(command, args, ...rest);
    };
    try {
      c.store.updateProjectName('Avant annulation');
      c.render();
      await pending;
      c.store.undo();
      c.render();
      release();
      await c.settle();
      assert.deepEqual(await c.recoveries(), []);
    } finally {
      release();
      window.__TAURI_INTERNALS__.invoke = original;
    }
  });
});

test('médiathèque et étiquettes ajoutées à une session intacte sont récupérables', async () => {
  await withSession(async c => {
    const path = await c.harness.writeFile('session/extra.mp3', 'audio');
    c.setLibrary([path], { [path]: ['Été'] });
    await c.settle();
    assert.equal((await c.recoveries()).length, 1);
    c.setLibrary([], {});
    await c.settle();
    assert.deepEqual(await c.recoveries(), []);
  });
});
