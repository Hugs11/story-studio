import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { I18nextProvider } from 'react-i18next';
import { installMountedDom, click } from './treeMountedDom.mjs';

async function setup() {
  const dom = installMountedDom();
  window.__TAURI_INTERNALS__ = { invoke: async () => [] };
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
  const engine = initializeI18n('fr');
  const host = document.createElement('div'); document.body.appendChild(host); const root = createRoot(host);
  return { dom, server, engine, host, root, async close() { await act(async () => root.unmount()); await server.close(); dom.restore(); } };
}
const author = { id: 'author', type: 'story', name: 'Auteur', audio: null, controlSettings: {} };

test('fin audio locale Home sans destination : option traduite présente et ouverte, navigation intacte', async () => {
  const s = await setup(); const changes = []; const errors = []; const previousError = console.error;
  console.error = (...args) => { errors.push(args.map(String).join(' ')); previousError(...args); };
  try {
    const { AfterPlaySection } = await s.server.ssrLoadModule('/src/components/editors/story/AfterPlaySection.jsx');
    const { ProjectActionsContext } = await s.server.ssrLoadModule('/src/store/ProjectActionsContext.js');
    const { ErrorDialogProvider } = await s.server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const node = { ...author, afterPlaybackPromptAudio: '/author.wav', afterPlaybackPromptHomeNone: true };
    const project = { projectType: 'pack', rootEntries: [node], globalOptions: {} }; const before = JSON.stringify(project);
    await act(async () => s.root.render(React.createElement(I18nextProvider, { i18n: s.engine }, React.createElement(ProjectActionsContext.Provider, { value: {} }, React.createElement(ErrorDialogProvider, null, React.createElement(AfterPlaySection, { node, project, allMenus: [], allStories: [node], onUpdate: fields => changes.push(fields) }))))));
    await act(async () => click(s.host.querySelector('.story-disclosure-trigger')));
    for (const [language, expected] of [['fr', 'Retour vers « Auteur »'], ['en', 'Return to “Auteur”'], ['it', 'Ritorno a «Auteur»']]) {
      await act(async () => s.engine.changeLanguage(language));
      const trigger = s.host.querySelectorAll('button').find(button => button.attributes.class === 'navigation-listbox-trigger' && button.textContent.includes(expected));
      assert.ok(trigger, `${language} sélection Home`);
      await act(async () => click(trigger));
      const options = s.host.querySelector('.navigation-listbox-popover').querySelectorAll('button');
      assert.ok(options.length > 0); assert.ok(options.every(button => button.textContent.trim()), `${language} aucune option vide`);
      const home = options.find(button => button.textContent.includes(expected)); assert.ok(home);
      await act(async () => click(home));
      assert.deepEqual(changes.at(-1), { afterPlaybackPromptHomeNone: true, afterPlaybackPromptHomeTarget: null });
      assert.equal(JSON.stringify(project), before);
    }
    assert.ok(!errors.some(message => message.includes('Functions are not valid')));
  } finally { console.error = previousError; await s.close(); }
});

test('scénario existant sans nom : langues sans dirty/undo, contrôle modifié sans renommer, nouvelle étape nommée une fois', async () => {
  const s = await setup(); let store;
  try {
    const { useProjectStore } = await s.server.ssrLoadModule('/src/store/projectStore.js');
    const { AfterPlaySection } = await s.server.ssrLoadModule('/src/components/editors/story/AfterPlaySection.jsx');
    const { ProjectActionsContext } = await s.server.ssrLoadModule('/src/store/ProjectActionsContext.js');
    const { ErrorDialogProvider } = await s.server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { normalizeSequenceStep } = await s.server.ssrLoadModule('/src/components/editors/story/storyUtils.jsx');
    function Mounted() {
      store = useProjectStore(); const node = store.project.rootEntries?.[0];
      return node && React.createElement(ProjectActionsContext.Provider, { value: {} }, React.createElement(ErrorDialogProvider, null, React.createElement(AfterPlaySection, { node, project: store.project, allMenus: [], allStories: [node], onUpdate: fields => store.updateItem(node.id, fields) })));
    }
    await act(async () => s.root.render(React.createElement(I18nextProvider, { i18n: s.engine }, React.createElement(Mounted))));
    await act(async () => { store.loadProject({ ...store.readProject(), projectType: 'pack', rootEntries: [{ ...author, afterPlaybackSequence: [{ id: 'existing', name: '', controlSettings: { autoplay: true } }, { id: 'other', name: 'Nom auteur …', audio: '/author-2.wav', controlSettings: { pause: true } }] }] }); store.markPristine(); });
    await act(async () => click(s.host.querySelector('.story-disclosure-trigger')));
    await act(async () => click(s.host.querySelector('.sequence-summary-icon-btn')));
    const before = JSON.stringify(store.readProject()); const undo = store.readHistoryMark(); const second = structuredClone(store.readProject().rootEntries[0].afterPlaybackSequence[1]);
    for (const [language, placeholder] of [['fr', 'Étape 1'], ['en', 'Step 1'], ['it', 'Fase 1']]) {
      await act(async () => s.engine.changeLanguage(language));
      assert.equal(s.host.querySelector('.sequence-step-name').getAttribute('placeholder'), placeholder);
      assert.equal(normalizeSequenceStep({ id: 'existing', name: '' }).name, '');
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
    }
    const first = s.host.querySelector('.sequence-step');
    await act(async () => click(first.querySelector('.tog')));
    const steps = store.readProject().rootEntries[0].afterPlaybackSequence;
    assert.equal(steps[0].name, ''); assert.equal(steps[0].id, 'existing'); assert.equal(steps[0].controlSettings.autoplay, false); assert.deepEqual(steps[1], second);
    const add = s.host.querySelectorAll('button').find(button => button.textContent === 'Aggiungi una fase'); assert.ok(add);
    await act(async () => click(add));
    assert.equal(store.readProject().rootEntries[0].afterPlaybackSequence[2].name, 'Fase 3');
    await act(async () => s.engine.changeLanguage('fr'));
    assert.equal(store.readProject().rootEntries[0].afterPlaybackSequence[2].name, 'Fase 3'); assert.equal(store.readProject().rootEntries[0].afterPlaybackSequence[0].name, '');
  } finally { await s.close(); }
});

test('vrai hook relink et dialogue ouvert : labels/recherche actualisés, signature de rejet et projet/undo préservés', async () => {
  const s = await setup(); let store, relink;
  try {
    const { useProjectStore } = await s.server.ssrLoadModule('/src/store/projectStore.js');
    const { useMissingMediaRelink } = await s.server.ssrLoadModule('/src/hooks/useMissingMediaRelink.js');
    const { MissingMediaRelinkModal } = await s.server.ssrLoadModule('/src/components/MissingMediaRelink/MissingMediaRelinkModal.jsx');
    const audit = { '/author.wav': false }; const library = { current: [] };
    function Mounted() {
      store = useProjectStore(); relink = useMissingMediaRelink({ store: { ...store, savePath: '/author/project.mbah' }, mediaLibraryPathsRef: library, setMediaLibraryPaths() {}, pathAudit: audit });
      return React.createElement(MissingMediaRelinkModal, { missingMedia: relink.missingMedia, onClose() {}, onApply() {} });
    }
    await act(async () => s.root.render(React.createElement(I18nextProvider, { i18n: s.engine }, React.createElement(Mounted))));
    await act(async () => { store.loadProject({ ...store.readProject(), projectType: 'pack', rootAudio: '/author.wav' }); store.markPristine(); });
    const dialog = document.body.querySelector('.relink-modal'); assert.ok(dialog);
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark(), signature = relink.missingMediaSignature;
    await act(async () => relink.setDismissedMissingMediaSignature(signature));
    function search(value) {
      const input = dialog.querySelector('input');
      const propsKey = Object.keys(input).find(key => key.startsWith('__reactProps$'));
      input[propsKey].onChange({ target: { value } });
    }
    for (const [language, label, query] of [['fr', 'Audio de couverture', 'couverture'], ['en', 'Cover audio', 'cover'], ['it', 'Audio di copertina', 'copertina']]) {
      await act(async () => { search(''); await s.engine.changeLanguage(language); });
      assert.equal(document.body.querySelector('.relink-modal'), dialog); assert.deepEqual(relink.missingMedia[0].labels, [label]); assert.ok(dialog.textContent.includes(label));
      await act(async () => search(query)); assert.equal(dialog.querySelectorAll('.relink-row').length, 1);
      await act(async () => search('not-a-match')); assert.equal(dialog.querySelectorAll('.relink-row').length, 0);
      assert.equal(relink.missingMediaSignature, signature); assert.equal(relink.dismissedMissingMediaSignature, signature);
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
    }
  } finally { await s.close(); }
});

test('copies projectIO : candidats et erreurs de transfert relisent les labels dans la langue active', async () => {
  const s = await setup();
  try {
    const { collectTransferableProjectFiles, transferProjectFilesToProject } = await s.server.ssrLoadModule('/src/store/projectIO.js');
    const project = { projectType: 'pack', rootAudio: '/external/author.wav', rootEntries: [], globalOptions: {} };
    const before = JSON.stringify(project);
    const candidates = collectTransferableProjectFiles(project, '/workspace/author.mbah');
    const failed = await transferProjectFilesToProject(project, '/workspace/author.mbah', async () => { throw new Error('RAW_COPY_ERROR'); });
    assert.equal(candidates.length, 1); assert.equal(failed.errors.length, 1); assert.equal(failed.copiedCount, 0);
    const errorAtCreation = failed.errors[0].error;
    for (const [language, label] of [['fr', 'Audio de couverture'], ['en', 'Cover audio'], ['it', 'Audio di copertina']]) {
      await act(async () => s.engine.changeLanguage(language));
      assert.equal(candidates[0].label, label); assert.equal(failed.errors[0].label, label);
      assert.equal(candidates[0].path, '/external/author.wav'); assert.equal(failed.errors[0].path, '/external/author.wav');
      assert.equal(failed.errors[0].error, errorAtCreation);
      assert.equal(JSON.stringify(project), before);
    }
  } finally { await s.close(); }
});

test('vrai transfert : dialogue conservé, label et cause codée relus FR EN IT, détail replié', async () => {
  const s = await setup();
  try {
    const { useMediaTransferHandlers } = await s.server.ssrLoadModule('/src/hooks/useMediaTransferHandlers.js');
    const { ErrorDialogProvider, useErrorDialog } = await s.server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { presentUserMessage } = await s.server.ssrLoadModule('/src/i18n/userMessage.js');
    const envelope = { code: 'FILES_MEDIA_COPY', params: { error: 'COPY_DENIED' }, detail: 'RAW_COPY' };
    const original = structuredClone(envelope); const calls = [];
    window.__TAURI_INTERNALS__.invoke = async (command, params) => { calls.push({ command, params }); throw envelope; };
    let handlers; let captured;
    function Consumer() {
      const { showErrorDialog } = useErrorDialog();
      handlers = useMediaTransferHandlers({ copyImportedFilesEnabled: true, workspaceDir: '/workspace', setWorkspaceDirState() {}, pathAudit: {}, dismissedTransferPromptRef: { current: null }, showErrorDialog(value) { captured = value; showErrorDialog(value); } });
      return null;
    }
    await act(async () => s.root.render(React.createElement(I18nextProvider, { i18n: s.engine }, React.createElement(ErrorDialogProvider, null, React.createElement(Consumer)))));
    const project = { projectType: 'pack', rootAudio: '/external/a.wav', rootEntries: [], globalOptions: {} }; const before = JSON.stringify(project);
    let result;
    await act(async () => { result = await handlers.maybeOfferTransferIntoProject(project, '/workspace/author.mbah', { skipPrompt: true }); });
    assert.equal(result.changed, false); assert.equal(result.errors.length, 1); assert.deepEqual(result.errors[0].userMessage, original);
    assert.ok(calls.some(call => call.command === 'copy_project_media' && call.params.sourcePath === '/external/a.wav'));
    const dialog = document.body.querySelector('.dialog-panel'); assert.ok(dialog);
    for (const [language, label] of [['fr', 'Audio de couverture'], ['en', 'Cover audio'], ['it', 'Audio di copertina']]) {
      await act(async () => s.engine.changeLanguage(language));
      assert.equal(document.body.querySelector('.dialog-panel'), dialog); assert.ok(dialog.textContent.includes('• ' + label));
      const presented = presentUserMessage(envelope);
      assert.equal(presented.code, 'FILES_MEDIA_COPY'); assert.notEqual(presented.code, 'UNEXPECTED_ERROR'); assert.equal(presented.fallback, false);
      assert.ok(dialog.textContent.includes(presented.message)); assert.equal(captured.technicalDetail, 'RAW_COPY');
      assert.equal(document.body.querySelector('details').getAttribute('open'), null);
      assert.doesNotMatch(dialog.textContent, /\[object Object\]|FILES_MEDIA_COPY/);
      if (language !== 'fr') assert.ok(!dialog.textContent.includes('Audio de couverture'));
      assert.deepEqual(envelope, original); assert.equal(JSON.stringify(project), before);
    }
  } finally { await s.close(); }
});
