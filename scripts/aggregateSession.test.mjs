import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useWorkSession } = await import('../src/hooks/useWorkSession.js');
const { prepareAggregateLanding } = await import('../src/components/AggregatePacks/aggregateLanding.js');
const io = await import('../src/store/projectIO.js');
const { defaultMetadataForPacks } = await import('../src/components/AggregatePacks/aggregateProject.js');
const { walkProjectMediaReferences } = await import('../src/store/projectModel.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const noop = () => {};
const ref = current => ({ current });

async function withSession(workspacePreference, run) {
  let next = 0;
  const cleaned = [];
  const harness = await createDiskHarness({ commands: {
    list_session_recoveries: () => [],
    create_session_workspace: () => harness.mkdirp(`session-${++next}`),
    cleanup_session_workspace: async ({ path }) => { cleaned.push(path); await fs.rm(path, { recursive: true, force: true }); },
  } });
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  const stores = runner(() => useProjectStore());
  let store = stores.render();
  const refs = {
    workspaceDirRef: ref(''), savedSnapshotRef: ref(null), autoSavePathRef: ref(null),
    autoSaveSnapshotRef: ref(null), mediaLibraryCountRef: ref(0), importedPackPendingMetaRef: ref(false),
  };
  const sessions = runner(() => useWorkSession({
    store, ...refs, sdStore: { clearDone: noop }, xttsStore: { clearDone: noop },
    showErrorDialog: noop, showChoiceDialog: async () => 'cancel',
    useWorkspaceForNewProjects: workspacePreference, configuredWorkspaceDir: harness.workspace,
    setConfiguredWorkspaceDir: noop, setWorkspaceDirState: noop, setAutoSavedPath: noop,
    setMediaLibraryPaths: noop, mediaLibraryPaths: [], mediaTags: {}, currentWorkSnapshot: null,
  }));
  const current = () => { store = stores.render(); return sessions.render(); };
  try { await run({ harness, cleaned, refs, current, readStore: () => { store = stores.render(); return store; } }); }
  finally { await harness.dispose(); }
}

for (const preference of [false, true]) {
  test(`aggregate landing owns a temporary session even with workspace preference ${preference}`, async () => {
    await withSession(preference, async ({ harness, current, readStore, cleaned }) => {
      const original = readStore().project;
      const session = current();
      let folder;
      await session.runFunnelLanding('pack', async (dir, details) => {
        folder = dir;
        assert.equal(details.mode, 'ephemeral');
        assert.notEqual(dir, harness.workspace);
        assert.equal(readStore().project, original, 'no premature project type installation');
      }, { forceEphemeral: true, applyProjectType: false });
      assert.equal(current().sessionWorkspaceDir, folder);
      assert.equal(current().sessionMode, 'ephemeral');
      assert.deepEqual(cleaned, []);
      await current().cleanupEphemeralSession();
      assert.deepEqual(cleaned, [folder]);
    });
  });

  test(`failed forced-session landing is abandoned with workspace preference ${preference}`, async () => {
    await withSession(preference, async ({ current, readStore, cleaned }) => {
      let folder;
      await assert.rejects(current().runFunnelLanding('pack', async dir => {
        folder = dir;
        throw { code: 'CATALOG_ASSEMBLY_TRANSFER_FAILED', params: {} };
      }, { forceEphemeral: true, applyProjectType: false }), error => error.code === 'CATALOG_ASSEMBLY_TRANSFER_FAILED');
      assert.equal(current().sessionMode, null);
      assert.equal(current().sessionWorkspaceDir, '');
      assert.equal(readStore().project.projectType, null);
      assert.deepEqual(cleaned, [folder]);
    });
  });
}

test('aggregate dependencies cross actual save, snapshot and reload functions before session cleanup', async () => {
  await withSession(false, async ({ harness, current, readStore, refs }) => {
    const zip = await harness.writeFile('assistant/Été.zip', 'synthetic ZIP bytes');
    const image = await harness.writeFile('assistant/cover.PNG', 'synthetic image bytes');
    const voice = await harness.writeFile('assistant/voix.mp3', 'synthetic voice bytes');
    const rootAudio = await harness.writeFile('assistant/menu.mp3', 'synthetic root audio');
    const rootImage = await harness.writeFile('assistant/menu.png', 'synthetic root image');
    const packs = [{ name: 'Été', path: zip, coverImage: image, coverAudio: voice }];
    const metadata = defaultMetadataForPacks(packs, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    let sessionDir;
    await current().runFunnelLanding('pack', async workspaceDir => {
      sessionDir = workspaceDir;
      const project = await prepareAggregateLanding({ draft: { packs, rootAudio, rootImage, metadata }, workspaceDir, copy: io.copyMediaToWorkspace });
      readStore().loadProject(project);
    }, { forceEphemeral: true, applyProjectType: false });
    await fs.rm(harness.dir('assistant'), { recursive: true });
    const project = readStore().project;
    assert.equal(project.packMetadata.minAge, '');
    const dependencies = await io.collectLiveSessionDependencies(project, sessionDir);
    assert.equal(dependencies.length, 5, 'ZIP, cover, cover voice and both root media');
    const snapshot = `${sessionDir}/.session-recovery.mbah`;
    await io.autoSaveEphemeralProject(project, sessionDir, snapshot);
    const recovered = await io.loadProjectFromPath(snapshot);
    assert.equal(recovered.data.packMetadata.uuid, metadata.uuid);
    assert.equal(recovered.data.packMetadata.minAge, '');
    const saveDir = await harness.mkdirp('saved');
    const savePath = `${saveDir}/Mon assemblage.mbah`;
    const transfer = await io.transferProjectFilesToProject(recovered.data, savePath, async source => {
      const target = `${saveDir}/${source.replaceAll('\\', '/').split('/').pop()}`;
      await fs.copyFile(source, target);
      return target;
    });
    assert.deepEqual(transfer.errors, []);
    assert.equal(transfer.copiedCount, 5);
    assert.deepEqual(await io.collectLiveSessionDependencies(transfer.project, sessionDir), []);
    await io.saveProject(transfer.project, savePath, null, { workspaceDir: saveDir });
    const session = current();
    const ticket = session.captureWorkSession();
    const stamp = {};
    refs.savedSnapshotRef.current = stamp;
    await session.promoteSessionToProject({ session: ticket, isPublicationCurrent: () => true, project: transfer.project, workspaceDir: saveDir });
    assert.equal(current().sessionMode, 'project');
    assert.equal(await harness.exists(sessionDir), false);
    const reopened = await io.loadProjectFromPath(savePath);
    assert.equal(reopened.data.packMetadata.uuid, metadata.uuid);
    assert.equal(reopened.data.packMetadata.minAge, '');
    for (const media of walkProjectMediaReferences(reopened.data)) assert.ok(await harness.exists(media.path), media.path);
    const exported = io.projectToRustExport(reopened.data);
    assert.equal(exported.packUuid, metadata.uuid);
    assert.equal(exported.rootEntries.length, 1);
  });
});

test('a failed durable dependency copy prevents session promotion', async () => {
  await withSession(false, async ({ harness, current, readStore }) => {
    const source = await harness.writeFile('assistant/pack.zip', 'archive');
    let sessionDir;
    await current().runFunnelLanding('pack', async dir => {
      sessionDir = dir;
      const packs = [{ name: 'Pack', path: source }];
      readStore().loadProject(await prepareAggregateLanding({ draft: { packs, rootAudio: '', rootImage: '', metadata: defaultMetadataForPacks(packs, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') }, workspaceDir: dir, copy: io.copyMediaToWorkspace }));
    }, { forceEphemeral: true, applyProjectType: false });
    const project = readStore().project;
    const result = await io.transferProjectFilesToProject(project, `${harness.workspace}/pack.mbah`, async () => { throw Error('copy failed'); });
    assert.equal(result.errors.length, 1);
    const session = current();
    await session.promoteSessionToProject({ session: session.captureWorkSession(), isPublicationCurrent: () => true, project: result.project, workspaceDir: harness.workspace });
    assert.equal(current().sessionMode, 'ephemeral');
    assert.equal(await harness.exists(sessionDir), true);
    assert.equal((await io.collectLiveSessionDependencies(result.project, sessionDir)).length, 1);
  });
});
