import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { installMountedDom, click } from './treeMountedDom.mjs';
import { pseudoResources } from '../src/i18n/pseudo.js';
import { sources, originalFrenchCountSource } from './i18nSettingsSourceFixture.mjs';

async function server(original) {
  return createServer({ configFile: false, plugins: [{ name: 'settings-counts-base-and-io', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && sources[file]) code = sources[file];
    if (original && file === 'src/utils/frenchText.js') return originalFrenchCountSource;
    if (id.endsWith('/store/projectIO.js')) return `export async function pickWorkspaceDir() { return null; }
      export async function consolidateProject() { return globalThis.__settingsCountResult; }
      export function rememberRecentProject() { return []; }`;
    if (id.endsWith('/store/generatedNavigation.js')) return `export function collectEndMessagePresentations() {
      return { filter() { return { length: globalThis.__settingsCount }; } };
    }`;
    if (id.endsWith('/useProjectMediaDirectory.js')) return 'export function useProjectMediaDirectory() { return "/_AUTHOR_DIRECTORY_"; }';
    if (id.endsWith('/tauriRuntime.js')) return 'export function isTauriRuntime() { return false; }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

test('réglages : quatre messages complets FR identiques aux sources BASE à 0/1/2/million', async () => {
  const dom = installMountedDom(), current = await server(false), original = await server(true);
  const roots = [];
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke(command, params) {
    if (command === 'plugin:dialog|open') return Promise.resolve('/_AUTHOR_DESTINATION_');
    return Promise.resolve(globalThis.__settingsCountInvoke(command, params));
  } };
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    for (const [namespace, values] of Object.entries(pseudoResources(engine.options.resources.fr))) engine.addResourceBundle('pseudo', namespace, values);
    const { presentStoredError } = await current.ssrLoadModule('/src/i18n/userMessage.js');
    const capture = async (srv, count, errors) => {
      const { useAppPreferences } = await srv.ssrLoadModule('/src/hooks/useAppPreferences.js');
      const { useXttsVoiceOptions } = await srv.ssrLoadModule('/src/tabs/OptionsTab/useXttsVoiceOptions.js');
      const { ProjectsMediaSection } = await srv.ssrLoadModule('/src/tabs/OptionsTab/ProjectsMediaSection.jsx');
      let preferences, xtts, confirmation, progress = null;
      const project = { projectType: 'pack', rootEntries: [] }, before = JSON.stringify(project);
      const result = { copiedCount: count, errors };
      globalThis.__settingsCount = count; globalThis.__settingsCountResult = result;
      globalThis.__settingsCountInvoke = (command, params) => {
        assert.equal(command, 'xtts_get_status'); assert.deepEqual(params, { settings: { serverUrl: '_AUTHOR_URL_' } });
        // Seuls length/join sont lus par les hooks : éviter un million de noms externes dans le DOM.
        return { model: '_AUTHOR_MODEL_', device: 'cpu', voices: { length: count, join: () => '_AUTHOR_VOICES_' } };
      };
      function App() {
        preferences = useAppPreferences({ store: { project }, setSaveProgress(value) { progress = typeof value === 'function' ? value(progress) : value; }, showConfirmDialog(dialog) { confirmation = dialog; return Promise.resolve(false); }, showErrorDialog() {} });
        xtts = useXttsVoiceOptions({ xttsSettings: { serverUrl: '_AUTHOR_URL_' }, onUpdateXttsSettings() { assert.fail('pas de mutation de préférence outil'); } });
        return React.createElement(React.Fragment, null,
          React.createElement('span', { className: 'count-probe' }, xtts.xttsProbe.message),
          React.createElement(ProjectsMediaSection, { project, onConsolidateProject: async () => result }));
      }
      const host = dom.document.createElement('div'); dom.document.body.appendChild(host); const root = createRoot(host); roots.push(root);
      await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(App))));
      await act(async () => { await xtts.testXtts(); await preferences.handleRemoveEndNode(); await preferences.handleConsolidateProject(); });
      await act(async () => click(host.querySelectorAll('button').find(b => b.textContent.trim() === 'Consolider')));
      const messages = {
        confirmation: presentStoredError(confirmation.message),
        xtts: host.querySelector('.count-probe').textContent,
        media: host.querySelector('.info-box').textContent.trim(),
        files: presentStoredError(progress.lines.at(-1)),
      };
      if (srv === current) {
        for (const language of ['en', 'it', 'pseudo']) {
          await act(async () => engine.changeLanguage(language));
          const translated = {
            confirmation: presentStoredError(confirmation.message),
            xtts: host.querySelector('.count-probe').textContent,
            media: host.querySelector('.info-box').textContent.trim(),
            files: presentStoredError(progress.lines.at(-1)),
          };
          for (const key of Object.keys(messages)) {
            assert.notEqual(translated[key], messages[key], `${language}:${key}, count=${count}`);
            assert.doesNotMatch(translated[key], /settings:[a-z]+\.|\[object Object\]/);
            if (language === 'pseudo') assert.ok(translated[key].includes('['), `surface pseudo ${key}`);
          }
          assert.equal(JSON.stringify(project), before);
        }
        await act(async () => engine.changeLanguage('fr'));
      }
      assert.equal(JSON.stringify(project), before);
      await act(async () => root.unmount()); roots.pop(); dom.document.body.removeChild(host);
      return messages;
    };
    for (const count of [0, 1, 2, 1_000_000]) for (const errors of [[], [{ path: '_AUTHOR_MISSING_', error: { code: 'COMFYUI_SERVICE_ERROR', params: {} } }]]) {
      const before = await capture(original, count, errors), after = await capture(current, count, errors);
      assert.deepEqual(after, before, `messages complets BASE : count=${count}, erreurs=${errors.length}`);
      if (count === 0) {
        assert.equal(after.confirmation, 'Le message sera retiré de 0 histoire. 0 fins locales seront conservées.');
        assert.equal(after.xtts, 'Serveur prêt • _AUTHOR_MODEL_ • CPU • 0 voix détectées');
        assert.ok(after.media.startsWith('Projet consolidé : 0 médias copiés'));
        assert.ok(after.files.startsWith('0 fichiers copiés'));
      }
    }
  } finally {
    for (const root of roots) await act(async () => root.unmount());
    delete globalThis.__settingsCount; delete globalThis.__settingsCountResult; delete globalThis.__settingsCountInvoke;
    await current.close(); await original.close(); dom.restore();
  }
});
