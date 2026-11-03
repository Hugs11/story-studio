import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { I18nextProvider } from 'react-i18next';
import { installMountedDom, click, renderedText } from './treeMountedDom.mjs';

test('vrai React monté : dialogue conservé, répertoires réels, table précréée, store/undo/signature invariants', async () => {
  const dom = installMountedDom();
  const server = await createServer({ configFile: false, plugins: [{ name: 'ipc-only-fixture', enforce: 'pre', transform(_code, id) {
    if (id.includes('/@tauri-apps/api/') && id.endsWith('/core.js')) return 'export function invoke(command, params) { return globalThis.__treeInvoke(command, params); } export function convertFileSrc(path) { return path; }';
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const pending = []; const calls = []; globalThis.__treeInvoke = (command, params) => { calls.push({ command, params }); if (command === 'comfyui_list_workflows') return Promise.resolve([{ id: 'author-workflow', name: '_AUTHOR_WORKFLOW_', slots: {}, requiresReferenceImage: true }]); return new Promise((resolve, reject) => { pending.push({ resolve, reject }); }); };
  globalThis.window.__TAURI_INTERNALS__ = { invoke: (command, params) => globalThis.__treeInvoke(command, params) };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    const { ProjectContext } = await server.ssrLoadModule('/src/store/ProjectContext.js');
    const { AudioField } = await server.ssrLoadModule('/src/components/editors/AudioField.jsx');
    const { SDGenerateModal } = await server.ssrLoadModule('/src/components/SDGenerateModal/SDGenerateModal.jsx');
    const { ImageField } = await server.ssrLoadModule('/src/components/editors/ImageField.jsx');
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { EndSequenceEditor } = await server.ssrLoadModule('/src/components/editors/story/EndSequenceEditor.jsx');
    const { EndMessagePlaybackControl } = await server.ssrLoadModule('/src/components/editors/EndMessagePlaybackControl.jsx');
    const { metadataSaveDecision } = await server.ssrLoadModule('/src/store/packMetadataModel.js');
    const { presentTree } = await server.ssrLoadModule('/src/i18n/treePresentation.js');
    const { useTreeTranslation } = await server.ssrLoadModule('/src/i18n/useTreeTranslation.jsx');
    let store; let mounts = 0; const notice = metadataSaveDecision({ status: 'held' }).noticeRef;
    const context = { pathAudit: {}, mediaStorage: null, savePath: null, workspaceDir: '', xttsSettings: {}, sdSettings: {}, sdJobs: [] };
    function Mounted() { store = useProjectStore(); useTreeTranslation(); React.useEffect(() => { mounts++; }, []); return React.createElement(ProjectContext.Provider, { value: context },
      React.createElement(React.Fragment, null, React.createElement(AudioField, {}), React.createElement(ImageField, { onPick() {}, onClear() {} }), React.createElement(EndMessagePlaybackControl, { summary: { total: 2, mode: 'wait' } }), React.createElement('p', null, presentTree(notice)), React.createElement(SDGenerateModal, { currentImagePath: '/_AUTHOR_REFERENCE_.png', currentImageLabel: { key: 'tree:image.current.fallback' }, onClose() {}, onGenerate() {} }), React.createElement(ErrorDialogProvider, null, React.createElement(EndSequenceEditor, { node: { id: 'author', name: '_AUTHOR_TITLE_' }, steps: [{ id: 'author-step', name: '_AUTHOR_STEP_', controlSettings: {} }], allMenus: [], allStories: [], onUpdate() {} })))); }
    await act(async () => { root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Mounted))); });
    await act(async () => { store.setProjectType('pack'); store.addMenu(null); store.updateMenu(store.readProject().rootEntries[0].id, { name: "Auteur « mon récit... »" }); store.markPristine(); });
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark(), signature = before;
    const mic = host.querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Enregistrer l’audio'); assert.ok(mic);
    await act(async () => { click(mic); });
    const dialog = host.querySelector('.modal-box'); assert.ok(dialog); assert.match(dialog.textContent, /Emplacement de travail en cours de résolution/);
    for (const [language, title, state] of [['fr', 'Projet non enregistré', 'Emplacement de travail en cours de résolution'], ['en', 'Unsaved project', 'Resolving the workspace folder'], ['it', 'Progetto non salvato', 'Risoluzione della cartella di lavoro']]) {
      await act(async () => { await engine.changeLanguage(language); });
      assert.equal(host.querySelector('.modal-box'), dialog); assert.match(dialog.textContent, new RegExp(title)); assert.match(dialog.textContent, new RegExp(state));
      assert.ok(renderedText(host).includes(engine.t('tree:image.replace.action'))); assert.ok(host.textContent.includes(engine.t('tree:metadata.save.held')));
      assert.ok(host.textContent.includes(engine.t('tree:image.reference.use', { label: engine.t('tree:image.current.fallback') })));
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(JSON.stringify(store.readProject()), signature); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
    }
    // Le hook reste intact : seule la frontière invoke est remplacée.
    context.mediaStorage = { root: '/_AUTHOR_ROOT_', storage: { folder: 'author', workId: 'author-id' }, ephemeral: false };
    await act(async () => { root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Mounted))); });
    assert.match(dialog.textContent, /Risoluzione della destinazione/); assert.ok(calls.filter(x => x.command === 'resolve_project_folder').every(x => x.params.create === false));
    await act(async () => { pending.splice(0).forEach(({ reject }) => reject({ code: 'FILES_PROJECT_FOLDER_RESOLVE_FAILED', params: {}, detail: 'RAW_ERROR' })); });
    assert.match(dialog.textContent, /Destinazione non disponibile/); assert.doesNotMatch(dialog.textContent, /RAW_ERROR|\[object Object\]/);
    context.mediaStorage = { ...context.mediaStorage, root: '/_AUTHOR_NEW_ROOT_' };
    await act(async () => { root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(Mounted))); });
    await act(async () => { pending.splice(0).forEach(({ resolve }) => resolve('_AUTHOR_FOLDER_'));  });
    assert.ok(dialog.textContent.includes('/_AUTHOR_NEW_ROOT_/enregistrements/_AUTHOR_FOLDER_'));
    for (const language of ['fr', 'en', 'it']) { await act(async () => { await engine.changeLanguage(language); }); assert.ok(dialog.textContent.includes('/_AUTHOR_NEW_ROOT_/enregistrements/_AUTHOR_FOLDER_')); }
    const dismiss = dialog.querySelectorAll('button').find(n => n.textContent === engine.t('common:dialog.cancel.label'));
    await act(async () => { click(dismiss); });
    const remove = host.querySelector('.sequence-icon-btn--danger'); assert.ok(remove);
    await act(async () => { click(remove); });
    const confirmation = dom.document.body.querySelector('.dialog-panel'); assert.ok(confirmation);
    for (const language of ['fr', 'en', 'it']) { await act(async () => { await engine.changeLanguage(language); }); assert.equal(dom.document.body.querySelector('.dialog-panel'), confirmation); assert.ok(confirmation.textContent.includes('_AUTHOR_STEP_')); assert.ok(confirmation.textContent.includes(engine.t('tree:story.delete.confirmTitle'))); assert.ok(confirmation.textContent.includes(engine.t('tree:story.sequence.confirmDelete', { name: '_AUTHOR_STEP_' }))); }
    assert.ok(JSON.stringify(store.readProject()).includes("Auteur « mon récit... »"));
    assert.equal(mounts, 1); assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
  } finally { await act(async () => root.unmount()); delete globalThis.__treeInvoke; await server.close(); dom.restore(); }
});
