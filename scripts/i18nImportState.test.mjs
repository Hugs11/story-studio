import test from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { presentStoredError } from '../src/i18n/userMessage.js';
import { createWorkSnapshot } from '../src/store/projectHelpers.js';
import { encodeProjectFile } from '../src/store/projectModel/codec.js';
import { youtubeImportFailureRef } from '../src/utils/youtubeErrors.js';
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { buildProjectIndex } = await import('../src/store/projectModel.js');
const { acquireImportedAdvancedProject } = await import('../src/store/projectModel/authoring.js');
const noop = () => {};

test('revue 1/3 : arguments actifs, cause retenue et dialogue de lot sans dirty/undo/sérialisation modifiés', async () => {
  i18next.init(createTestI18n().options);
  const blocked = { code: 'blocked', params: {}, detail: 'RAW_YTDLP' };
  const namedCalls = [];
  const disk = await createDiskHarness({ commands: {
    download_youtube_audio: async () => { throw blocked; },
    scan_import_folder: async args => { namedCalls.push(['folder', args]); return { type: 'folder', name: args.proposedFolderName, children: [] }; },
    acquire_advanced_pack_document: async args => { namedCalls.push(['pack', args]); return { payload: '{}', mediaBindings: [] }; },
  } });
  try {
    let store, imports, dialog;
    const app = runner(() => {
      store = useProjectStore();
      imports = useImportSession({ store, projectIndex: buildProjectIndex(store.project), workspaceDirRef: { current: disk.workspace },
        mediaStorageRef: { current: { root: disk.workspace } }, sessionModeRef: { current: 'project' },
        setImporting: noop, setUnpacking: noop, setImportNotice: noop,
        showErrorDialog: value => { dialog = value; },
      });
    });
    app.render();
    store.addStory(null, '/AUTHOR.mp3'); app.render();
    store.updateProjectName('Auteur'); app.render();
    store.markPristine(); app.render();
    const signature = createWorkSnapshot(store.project);
    const serialized = encodeProjectFile(store.project);
    const history = store.readHistoryMark();
    const pristine = store.isPristine();
    const canUndo = store.canUndo;
    const canRedo = store.canRedo;
    const result = await imports.handleImportMediaEpisodes([
      { id: 'a', title: 'Titre auteur', audioUrl: 'https://youtube.com/watch?v=a' },
      { id: 'b', title: 'Autre titre', audioUrl: 'https://youtube.com/watch?v=b' },
    ], { title: 'Source auteur' }, { source: 'youtube' });
    assert.equal(result.firstError, blocked);
    assert.equal(result.firstErrorCode, 'blocked');
    assert.notEqual(result.firstErrorCode, 'private');
    assert.deepEqual(result.firstError.params, {});
    assert.equal(result.skipped, 1);
    const retainedDialog = dialog;
    assert.equal(retainedDialog.technicalDetail, 'RAW_YTDLP');
    assert.deepEqual(retainedDialog.message, { key: 'import:youtube.batch.failure' });
    const failure = youtubeImportFailureRef(result, { key: 'import:youtube.import.failure' });
    const capturedTitle = [];
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      app.render();
      capturedTitle.push(retainedDialog.title);
      assert.equal(presentStoredError(retainedDialog.message), i18next.t('import:youtube.batch.failure'));
      assert.doesNotMatch(presentStoredError(failure), /\[object Object\]|RAW_YTDLP/);
      if (language !== 'fr') assert.doesNotMatch(presentStoredError(failure), /demande une vérification|n'a pu être importée/);
      assert.equal(createWorkSnapshot(store.project), signature);
      assert.equal(encodeProjectFile(store.project), serialized);
      assert.equal(store.readHistoryMark(), history);
      assert.equal(store.isPristine(), pristine);
      assert.equal(store.canUndo, canUndo);
      assert.equal(store.canRedo, canRedo);
      // Points de support réels : scan et acquisition, transport Tauri seul doublé.
      disk.answerOpen('/AUTHOR/folder');
      await imports.handleImportFolder();
      assert.equal(namedCalls.at(-1)[1].proposedFolderName, i18next.t('import:names.folder.fallback'));
      const acquired = await acquireImportedAdvancedProject({ packPath: '/AUTHOR/pack.zip', assetsDir: disk.project, workspaceDir: disk.workspace, projectName: 'Auteur', storage: store.project.storage, ephemeral: false });
      // Correction revue Claude : aucun nom proposé dans le document graphe.
      assert.equal(Object.hasOwn(namedCalls.at(-1)[1], 'proposedPackName'), false);
      assert.equal(acquired.projectName, 'Auteur');
      assert.equal(createWorkSnapshot(store.project), signature);
    }
    assert.equal(new Set(capturedTitle).size, 3);
    await i18next.changeLanguage('fr');
    app.unmount();
  } finally { await disk.dispose(); }
});
