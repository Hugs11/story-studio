import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { installMountedDom, click } from './treeMountedDom.mjs';

test('réglages montés : états de progression et dialogue ouverts suivent FR → EN → IT sans dirty/undo', async () => {
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
  const server = await createServer({ configFile: false, plugins: [react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const calls = [];
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: async (command, params) => {
    calls.push({ command, params });
    if (command === 'xtts_get_status') return { voices: ['_AUTHOR_VOICE_'], device: 'cpu', model: '_AUTHOR_MODEL_' };
    if (command === 'piper_list_voices') return { voices: [] };
    if (command === 'comfyui_list_workflows') return [];
    if (command === 'comfyui_check') throw { code: 'COMFYUI_SERVICE_ERROR', params: {}, detail: '_RAW_TOOL_' };
    if (command === 'plugin:event|listen') return 1;
    if (command === 'plugin:event|unlisten') return undefined;
    assert.fail(`commande inattendue : ${command}`);
  } };
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { VoiceSection } = await server.ssrLoadModule('/src/tabs/OptionsTab/VoiceSection.jsx');
    const { AiImagesSection } = await server.ssrLoadModule('/src/tabs/OptionsTab/AiImagesSection.jsx');
    const { OptionsSectionNav } = await server.ssrLoadModule('/src/tabs/OptionsTab/OptionsSectionNav.jsx');
    const { THEME_OPTIONS } = await server.ssrLoadModule('/src/store/themePreference.js');
    const { PIPER_LANGUAGE_OPTIONS } = await server.ssrLoadModule('/src/store/xttsSettings.js');
    const { useAppPreferences } = await server.ssrLoadModule('/src/hooks/useAppPreferences.js');
    const { ErrorDialogProvider, useErrorDialog } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { useProjectStore } = await server.ssrLoadModule('/src/store/projectStore.js');
    const themes = JSON.stringify(THEME_OPTIONS), languages = JSON.stringify(PIPER_LANGUAGE_OPTIONS);
    let store, preferences, mounts = 0;
    function App() {
      store = useProjectStore(); const dialogs = useErrorDialog();
      preferences = useAppPreferences({ store, ...dialogs });
      React.useEffect(() => { mounts++; }, []);
      const fail = () => assert.fail('aucune mise à jour des préférences outils ou du projet par la langue');
      return React.createElement(React.Fragment, null,
        React.createElement(VoiceSection, { xttsSettings: { backend: 'xtts', language: 'fr', serverUrl: '_AUTHOR_URL_', favoriteVoices: [] }, onUpdateXttsSettings: fail }),
        React.createElement(AiImagesSection, { sdSettings: { aiImageGen: true, serverUrl: '_AUTHOR_URL_' }, onUpdateSdSettings: fail }),
        React.createElement(OptionsSectionNav, { activeSectionId: 'save', onNavigate() {} }));
    }
    await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(ErrorDialogProvider, null, React.createElement(App)))));
    const before = JSON.stringify(store.readProject()), undo = store.readHistoryMark();
    await act(async () => click(host.querySelector('.xtts-actions').querySelector('button')));
    assert.ok(host.textContent.includes(engine.t('settings:xtts.ready.message', { model: '_AUTHOR_MODEL_', device: 'CPU', voices: engine.t('settings:xtts.voices.count', { count: 1 }), names: ' • _AUTHOR_VOICE_' })));
    await act(async () => click(host.querySelector('#comfyui').querySelector('.xtts-actions').querySelector('button')));
    assert.equal(host.querySelector('details').getAttribute('open'), null);
    assert.ok(host.querySelector('pre').textContent.includes('_RAW_TOOL_'));
    let removePromise;
    await act(async () => { removePromise = preferences.handleRemoveEndNode(); });
    const dialog = dom.document.body.querySelector('.dialog-panel'); assert.ok(dialog);
    const xtts = host.querySelector('#xtts');
    for (const language of ['fr', 'en', 'it']) {
      await act(async () => engine.changeLanguage(language));
      assert.equal(dom.document.body.querySelector('.dialog-panel'), dialog); assert.equal(host.querySelector('#xtts'), xtts);
      assert.ok(dialog.textContent.includes(engine.t('settings:end.remove.title')));
      assert.ok(dialog.textContent.includes(engine.t('settings:end.remove.noLocalEndings')));
      assert.ok(host.textContent.includes(engine.t('settings:images.test.action')));
      assert.ok(host.textContent.includes(engine.t('settings:xtts.voices.count', { count: 1 })));
      assert.ok(host.textContent.includes(engine.t('rust:COMFYUI_SERVICE_ERROR')));
      assert.equal(JSON.stringify(store.readProject()), before); assert.equal(store.readHistoryMark(), undo);
      assert.equal(JSON.stringify(THEME_OPTIONS), themes); assert.equal(JSON.stringify(PIPER_LANGUAGE_OPTIONS), languages);
    }
    await act(async () => click(dialog.querySelectorAll('button').find(b => b.textContent === engine.t('common:dialog.cancel.label'))));
    assert.equal(await removePromise, false); assert.equal(mounts, 1);
    assert.equal(calls.filter(c => c.command === 'xtts_get_status').length, 1);
    assert.deepEqual(calls.find(c => c.command === 'xtts_get_status').params, { settings: { backend: 'xtts', language: 'fr', serverUrl: '_AUTHOR_URL_', favoriteVoices: [] } });
  } finally { await act(async () => root.unmount()); await server.close(); dom.restore(); }
});
