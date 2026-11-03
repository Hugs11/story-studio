import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { installMountedDom, click } from './treeMountedDom.mjs';

// Vrai React monté : mêmes modales, mêmes paramètres et mêmes données de travail.
test('IA montée : FR → EN → IT, dialogue et tables conservés, requête TTS figée', async () => {
  const dom = installMountedDom();
  // Le DOM minimal partagé ne simule pas encore les options d’un select natif.
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = name => {
    const element = createElement(name);
    if (name === 'select') {
      Object.defineProperty(element, 'options', { get: () => element.querySelectorAll('option') });
      Object.defineProperty(element, 'value', { get: () => element.options.find(o => o.selected)?.value ?? '', set() {} });
    }
    if (name === 'option') Object.defineProperty(element, 'value', { get: () => element.getAttribute('value') ?? element.textContent, set(value) { element.setAttribute('value', value); } });
    return element;
  };
  const server = await createServer({ configFile: false, plugins: [{ name: 'ai-ipc-fixture', enforce: 'pre', transform(_code, id) {
    if (id.includes('/@tauri-apps/api/') && id.endsWith('/core.js')) return 'export function invoke(command, params) { return globalThis.__aiInvoke(command, params); } export function convertFileSrc(path) { return path; }';
    if (id.endsWith('/useLocalFile.js')) return 'export function useLocalFile() { return null; }';
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const calls = [], queued = [];
  globalThis.__aiInvoke = (command, params) => {
    calls.push({ command, params });
    if (command === 'comfyui_list_workflows') return Promise.resolve([{ id: 'wf', name: '_AUTHOR_WF_', description: '_AUTHOR_DESC_', slots: { seed: {}, steps: {}, cfg: {}, lora_strength_model: {}, negative_prompt: {} } }]);
    if (command === 'xtts_get_status') return Promise.resolve({ voices: ['_AUTHOR_VOICE_'], device: 'cpu' });
    return Promise.resolve();
  };
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: (command, params) => globalThis.__aiInvoke(command, params) };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { GenerateVoiceModal } = await server.ssrLoadModule('/src/components/GenerateVoiceModal/GenerateVoiceModal.jsx');
    const { SDGenerateModal } = await server.ssrLoadModule('/src/components/SDGenerateModal/SDGenerateModal.jsx');
    const { SDQueuePanel } = await server.ssrLoadModule('/src/components/SDQueuePanel/SDQueuePanel.jsx');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    const { getImageJobTargetRef } = await server.ssrLoadModule('/src/store/aiJobLabels.js');
    const { QUEUE_COLUMNS } = await server.ssrLoadModule('/src/components/SDQueuePanel/useQueueColumnWidths.js');
    const columnsBefore = JSON.stringify(QUEUE_COLUMNS);
    const requestText = '_AUTHOR_TEXT_ récit...';
    const jobs = [{ id: 'j', status: 'pending', targetLabelRef: getImageJobTargetRef({ fieldId: 'root:rootImage' }) }];
    let store, mounts = 0;
    function App() {
      store = useProjectStore();
      React.useEffect(() => { mounts += 1; }, []);
      return React.createElement(React.Fragment, null,
        React.createElement(GenerateVoiceModal, { xttsSettings: { backend: 'xtts', language: 'fr' }, label: '_AUTHOR_LABEL_', initialText: requestText, onQueueGenerate: job => queued.push(job), onClose: () => {} }),
        React.createElement(SDGenerateModal, { onClose: () => {}, onGenerate: () => {} }),
        React.createElement(SDQueuePanel, { imageJobs: jobs, embedded: true }));
    }
    await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(App))));
    await act(async () => store.markPristine());
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark();
    const modal = host.querySelector('.tts-modal'), imageModal = host.querySelector('.sd-generate-box');
    // Lot select A : la liste de langue est le composant Select (bouton combobox) et non plus un <select> natif.
    const ttsSelect = modal.querySelector('.select-trigger');
    assert.equal(ttsSelect.textContent, engine.t('ai:voice.language.fr'));
    const advanced = imageModal.querySelector('.sd-advanced-toggle');
    await act(async () => click(advanced));
    assert.ok(imageModal.querySelector('.sd-advanced-body'));
    for (const lng of ['fr', 'en', 'it']) {
      await act(async () => engine.changeLanguage(lng));
      assert.equal(host.querySelector('.tts-modal'), modal);
      assert.equal(host.querySelector('.sd-generate-box'), imageModal);
      assert.ok(modal.textContent.includes(engine.t('ai:voice.generation.title')));
      assert.ok(modal.textContent.includes(engine.t('ai:voice.xtts.ready')));
      assert.equal(modal.querySelector('textarea').value, requestText);
      assert.equal(ttsSelect.textContent, engine.t('ai:voice.language.fr'));
      assert.ok(host.querySelector('.sd-queue-table').textContent.includes(engine.t('ai:queue.column.name')));
      assert.ok(host.querySelector('.sd-queue-table').textContent.includes(engine.t('ai:target.root.image')));
      assert.equal(imageModal.querySelector('.sd-textarea').value, 'lunii_style, simple illustration, black and white line art, grayscale, children book style, ');
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
    }
    await act(async () => click(modal.querySelector('.tts-footer-actions').querySelector('button')));
    assert.equal(queued.length, 1); assert.equal(queued[0].request.text, requestText); assert.equal(queued[0].request.language, 'fr'); assert.equal(queued[0].request.voice, '_AUTHOR_VOICE_');
    const request = JSON.stringify(queued[0].request);
    await act(async () => engine.changeLanguage('en'));
    assert.equal(JSON.stringify(queued[0].request), request);
    assert.equal(JSON.stringify(QUEUE_COLUMNS), columnsBefore); assert.equal(mounts, 1);
    assert.deepEqual(calls.map(c => c.command).sort(), ['comfyui_list_workflows', 'xtts_get_status']);
  } finally { await act(async () => root.unmount()); delete globalThis.__aiInvoke; await server.close(); dom.restore(); }
});

test('jobs audio réels : champ racine et sélection multiple conservent les références et la requête', async () => {
  const dom = installMountedDom();
  const createElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = name => {
    const element = createElement(name);
    if (name === 'select') {
      Object.defineProperty(element, 'options', { get: () => element.querySelectorAll('option') });
      Object.defineProperty(element, 'value', { get: () => element.options.find(o => o.selected)?.value ?? '', set() {} });
    }
    if (name === 'option') Object.defineProperty(element, 'value', { get: () => element.getAttribute('value') ?? element.textContent, set(value) { element.setAttribute('value', value); } });
    return element;
  };
  const server = await createServer({ configFile: false, plugins: [{ name: 'audio-job-ipc-only', enforce: 'pre', transform(_code, id) {
    if (id.endsWith('/useLocalFile.js')) return 'export function useLocalFile() { return null; }';
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const calls = [];
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: async (command, params) => {
    calls.push({ command, params });
    if (command === 'xtts_get_status') return { voices: ['_AUTHOR_VOICE_'], device: 'cpu' };
    assert.fail(`commande inattendue : ${command}`);
  } };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  let jobs;
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { RootEditor } = await server.ssrLoadModule('/src/components/editors/RootEditor.jsx');
    const { MultiEditor } = await server.ssrLoadModule('/src/components/editors/MultiEditor.jsx');
    const { ProjectContext } = await server.ssrLoadModule('/src/store/ProjectContext.js');
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { SDQueuePanel } = await server.ssrLoadModule('/src/components/SDQueuePanel/SDQueuePanel.jsx');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    const { useXttsStore } = await server.ssrLoadModule('/src/store/xttsStore.js');
    const { useAiGeneration } = await server.ssrLoadModule('/src/hooks/useAiGeneration.js');
    const { buildProjectIndex } = await server.ssrLoadModule('/src/store/projectModel/index.js');
    const { pseudoResources } = await server.ssrLoadModule('/src/i18n/pseudo.js');
    for (const [ns, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', ns, values);
    const authorName = 'Auteur « mon récit... »';
    const settings = { backend: 'xtts', enabled: true, language: 'fr', favoriteVoices: ['_AUTHOR_VOICE_'] };
    let store, generation;
    function App() {
      store = useProjectStore(); jobs = useXttsStore();
      const mediaStorageRef = React.useRef({ root: '/_AUTHOR_WORKSPACE_', ephemeral: true });
      const project = store.readProject(); const projectIndex = buildProjectIndex(project);
      generation = useAiGeneration({ store, mediaStorageRef, xttsStore: jobs, sdStore: { jobs: [] }, projectIndex, xttsSettings: settings, setBottomPanelOpen() {}, setBottomPanelTab() {} });
      const context = { workspaceDir: '/_AUTHOR_WORKSPACE_', mediaStorage: mediaStorageRef.current, xttsSettings: settings, pathAudit: {}, onQueueXttsGenerate: generation.handleQueueXttsGenerate };
      const failMutation = () => assert.fail('aucune mutation auteur par la génération ou la langue');
      return React.createElement(ProjectContext.Provider, { value: context }, React.createElement(ErrorDialogProvider, null,
        React.createElement(RootEditor, { node: project, projectType: 'pack', onUpdateRoot: failMutation, onUpdateMedia: failMutation, onUpdateStoryAudio: failMutation, onUpdateOption: failMutation }),
        React.createElement(MultiEditor, { project, projectIndex, selectedIds: new Set(project.rootEntries.map(e => e.id)), allMenus: [], allStories: [], onBulkUpdateItems: failMutation, onBulkDeleteItems: failMutation }),
        React.createElement(SDQueuePanel, { audioJobs: jobs.jobs, embedded: true })));
    }
    await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(App))));
    await act(async () => { store.setProjectType('pack'); store.addMenu(null); store.updateMenu(store.readProject().rootEntries[0].id, { name: authorName }); store.markPristine(); });
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark();
    const speech = host.querySelector('.root-audio-section').querySelectorAll('button').find(b => b.getAttribute('aria-label') === engine.t('tree:audio.voice.action'));
    assert.ok(speech);
    await act(async () => click(speech));
    const modal = host.querySelector('.tts-modal'); assert.ok(modal);
    await act(async () => click(modal.querySelector('.tts-footer-actions').querySelector('button')));
    assert.equal(jobs.jobs.length, 1);
    assert.deepEqual(jobs.jobs[0].targetLabelRef, { key: 'tree:root.titleAudio.label' });
    assert.equal(jobs.jobs[0].label, ''); assert.equal(jobs.jobs[0].targetLabel, '');
    const batch = host.querySelectorAll('button').find(b => b.textContent === engine.t('tree:multi.titles.audio'));
    assert.ok(batch);
    await act(async () => click(batch));
    assert.equal(jobs.jobs.length, 2);
    assert.deepEqual(jobs.jobs[1].targetLabelRef, { key: 'tree:multi.voice.target', params: { name: authorName } });
    await act(async () => generation.handleQueueXttsGenerate({ targetLabel: 'Titre audio', voiceLabel: '_AUTHOR_VOICE_', request: { text: '_AUTHOR_HISTORY_', language: 'fr' } }));
    assert.equal(jobs.jobs.length, 3);
    assert.equal(jobs.jobs[2].targetLabelRef, null);
    assert.equal(jobs.jobs[2].label, 'Titre audio');
    const requests = jobs.jobs.map(job => JSON.stringify(job.request));
    for (const lng of ['fr', 'en', 'it', 'pseudo']) {
      await act(async () => engine.changeLanguage(lng));
      const panel = host.querySelector('.sd-queue-embedded');
      const titles = panel.querySelectorAll('.sd-cell-main').map(n => n.textContent);
      const targets = panel.querySelectorAll('.sd-cell-text').map(n => n.textContent);
      for (const expected of [engine.t('tree:root.titleAudio.label'), engine.t('tree:multi.voice.target', { name: authorName })]) {
        assert.ok(titles.includes(expected), `${lng} titre ${expected}`);
        assert.ok(targets.includes(expected), `${lng} destination ${expected}`);
      }
      assert.ok(titles.includes('Titre audio'), 'chaîne historique/auteur conservée sans analyse de sa traduction');
      assert.ok(targets.includes('Titre audio'));
      assert.deepEqual(jobs.jobs.map(job => JSON.stringify(job.request)), requests);
      assert.equal(jobs.jobs[1].request.text, authorName); assert.equal(jobs.jobs[1].request.language, 'fr');
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo); assert.equal(store.isPristine(), true);
    }
    assert.deepEqual(calls.map(c => c.command), ['xtts_get_status']);
  } finally { await act(async () => { for (const job of jobs?.jobs ?? []) jobs.removeJob(job.id); }); await act(async () => root.unmount()); await server.close(); dom.restore(); }
});

test('jobs audio du graphe : le libellé de destination suit la langue changée après la création', async () => {
  const dom = installMountedDom();
  const server = await createServer({ configFile: false, plugins: [{ name: 'graph-audio-job-fixture', enforce: 'pre', transform(_code, id) {
    if (id.endsWith('/useLocalFile.js')) return 'export function useLocalFile() { return null; }';
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: async command => assert.fail(`commande inattendue : ${command}`) };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  let jobs;
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { GraphSelectionEditor } = await server.ssrLoadModule('/src/components/AdvancedWorkspace/GraphSelectionEditor.jsx');
    const { ProjectContext } = await server.ssrLoadModule('/src/store/ProjectContext.js');
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { SDQueuePanel } = await server.ssrLoadModule('/src/components/SDQueuePanel/SDQueuePanel.jsx');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    const { useXttsStore } = await server.ssrLoadModule('/src/store/xttsStore.js');
    const { useAiGeneration } = await server.ssrLoadModule('/src/hooks/useAiGeneration.js');
    const { buildProjectIndex } = await server.ssrLoadModule('/src/store/projectModel/index.js');
    const { STAGE_KIND } = await server.ssrLoadModule('/src/store/advancedGraphView/graphViewModel.js');
    const names = ['Titre auteur un', 'Titre auteur deux'];
    const entries = names.map((name, ordinal) => ({ kind: STAGE_KIND, path: `stage-${ordinal}`, node: { uuid: `graph-stage-${ordinal}`, controls: {} }, label: { label: name, isFallback: false } }));
    const settings = { backend: 'piper', enabled: true, language: 'fr', piperVoice: '_AUTHOR_VOICE_' };
    let generation;
    function App() {
      const store = useProjectStore(); jobs = useXttsStore();
      const mediaStorageRef = React.useRef({ root: '/_AUTHOR_WORKSPACE_', ephemeral: true });
      generation = useAiGeneration({ store, mediaStorageRef, xttsStore: jobs, sdStore: { jobs: [] }, projectIndex: buildProjectIndex(store.readProject()), xttsSettings: settings, setBottomPanelOpen() {}, setBottomPanelTab() {} });
      const context = { workspaceDir: '/_AUTHOR_WORKSPACE_', mediaStorage: mediaStorageRef.current, xttsSettings: settings, pathAudit: {}, onQueueXttsGenerate: generation.handleQueueXttsGenerate };
      return React.createElement(ProjectContext.Provider, { value: context }, React.createElement(ErrorDialogProvider, null,
        React.createElement(GraphSelectionEditor, { entries, projectEpoch: 42, onAssignMedia() {} }),
        React.createElement(SDQueuePanel, { audioJobs: jobs.jobs, embedded: true })));
    }
    await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(App))));
    const button = host.querySelectorAll('button').find(b => b.textContent === engine.t('graph:selection.audios.label'));
    assert.ok(button);
    await act(async () => click(button));
    assert.equal(jobs.jobs.length, 2);
    assert.deepEqual(jobs.jobs.map(job => job.targetLabelRef), names.map(name => ({ key: 'graph:selection.audio.target', params: { name } })));
    assert.ok(jobs.jobs.every(job => job.targetLabel === '' && job.label === ''));
    const requests = jobs.jobs.map(job => JSON.stringify(job.request));
    for (const lng of ['fr', 'en', 'it']) {
      await act(async () => engine.changeLanguage(lng));
      const targets = host.querySelector('.sd-queue-embedded').querySelectorAll('.sd-cell-text').map(n => n.textContent);
      for (const name of names) assert.ok(targets.includes(engine.t('graph:selection.audio.target', { name })), `${lng} destination ${name}`);
      assert.deepEqual(jobs.jobs.map(job => JSON.stringify(job.request)), requests);
      assert.deepEqual(jobs.jobs.map(job => job.request.text), names);
    }
  } finally { await act(async () => { for (const job of jobs?.jobs ?? []) jobs.removeJob(job.id); }); await act(async () => root.unmount()); await server.close(); dom.restore(); }
});
