import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import { installMountedDom, click } from './treeMountedDom.mjs';

async function surface(run) {
  const dom = installMountedDom();
  const previousFrame = globalThis.requestAnimationFrame, previousCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = callback => { callback(); return 1; };
  globalThis.cancelAnimationFrame = () => {};
  dom.document.getElementById = id => dom.document.body.querySelector('#' + id);
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
  const values = new Map();
  dom.document.defaultView.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  // Only unrelated settings sections are replaced; the home, notice, routing,
  // preferences shell and real InterfaceSection/language select are mounted.
  const unrelated = ['SaveSection', 'CatalogueSection', 'ProjectsMediaSection', 'VoiceSection', 'AiImagesSection', 'AdvancedSection', 'YoutubeSection', 'DiagnosticSection'];
  const server = await createServer({ configFile: false, plugins: [{ name: 'unrelated-preferences', enforce: 'pre', transform(_code, id) {
    const name = unrelated.find(name => id.replaceAll('\\', '/').endsWith('/OptionsTab/' + name + '.jsx'));
    if (name) return 'export function ' + name + '() { return null; }';
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  let root;
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    const language = await server.ssrLoadModule('/src/i18n/language.js');
    const { KEYS } = await server.ssrLoadModule('/src/store/persistentSettings.js');
    const { ModeSelector } = await server.ssrLoadModule('/src/components/ModeSelector/ModeSelector.jsx');
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    const { OptionsTab } = await server.ssrLoadModule('/src/tabs/OptionsTab.jsx');
    const { useOptionsTabProps } = await server.ssrLoadModule('/src/hooks/useOptionsTabProps.js');
    const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
    const mount = async () => {
      let route;
      function App() {
        const [open, setOpen] = React.useState(false);
        const options = useOptionsTabProps({ onOpen: () => setOpen(true) });
        route = options;
        return React.createElement(ErrorDialogProvider, null,
          React.createElement(ModeSelector, { onSelect() {}, onOpenPreferences: options.openPreferences }),
          open && React.createElement(OptionsTab, { ...options, asModal: true, onClose: () => { options.onPreferencesClosed(); setOpen(false); } }));
      }
      root = createRoot(host);
      await act(async () => root.render(React.createElement(App)));
      return () => route;
    };
    const restart = async system => {
      if (root) { await act(async () => root.unmount()); root = null; }
      const resolved = language.loadLanguage(system);
      initializeI18n(resolved);
      return { resolved, route: await mount() };
    };
    await run({ values, KEYS, language, initializeI18n, host, dom, restart });
  } finally {
    if (root) await act(async () => root.unmount());
    await server.close(); dom.restore();
    if (previousFrame === undefined) delete globalThis.requestAnimationFrame; else globalThis.requestAnimationFrame = previousFrame;
    if (previousCancel === undefined) delete globalThis.cancelAnimationFrame; else globalThis.cancelAnimationFrame = previousCancel;
  }
}

for (const [name, existing, system, expected, notice] of [
  ['existing EN', true, 'en-US', 'fr', true],
  ['existing FR', true, 'fr-CA', 'fr', false],
  ['existing IT', true, 'it-IT', 'fr', true],
  ['new EN', false, 'en-US', 'en', false],
  ['new DE', false, 'de-DE', 'en', false],
  ['new FR', false, 'fr-FR', 'fr', false],
]) {
  test('F1b migration and home announcement: ' + name, async () => surface(async ({ values, KEYS, host, restart }) => {
    if (existing) values.set(KEYS.THEME, 'system');
    const first = await restart(system);
    assert.equal(first.resolved, expected);
    assert.equal(values.get(KEYS.UI_LANGUAGE), expected);
    assert.equal(!!host.querySelector('.import-notice--inline'), notice);
    assert.equal(values.get(KEYS.UI_LANGUAGE_ANNOUNCEMENT), notice ? 'pending' : undefined);
    const second = await restart(system);
    assert.equal(second.resolved, expected, 'the migrated or system language remains an explicit preference');
    assert.equal(!!host.querySelector('.import-notice--inline'), notice);
  }));
}

test('F1b close persists across the next launch', async () => surface(async ({ values, KEYS, host, restart }) => {
  values.set(KEYS.THEME, 'dark');
  await restart('en-US');
  assert.match(host.querySelector('.import-notice-text').textContent, /Story Studio est maintenant disponible en anglais et en italien\./);
  await act(async () => click(host.querySelector('.import-notice-close')));
  assert.equal(host.querySelector('.import-notice--inline'), null);
  assert.equal(values.get(KEYS.UI_LANGUAGE_ANNOUNCEMENT), 'dismissed');
  await restart('en-US');
  assert.equal(host.querySelector('.import-notice--inline'), null);
  assert.equal(values.get(KEYS.UI_LANGUAGE), 'fr');
}));

test('F1b action targets Interface, focuses the real language select and acknowledges once', async () => surface(async ({ values, KEYS, host, dom, restart }) => {
  values.set(KEYS.THEME, 'dark');
  const { route } = await restart('en-US');
  const action = host.querySelector('.import-notice--inline').querySelector('.btn-xs');
  assert.equal(action.textContent, 'Changer de langue');
  await act(async () => click(action));
  assert.equal(route().initialSection, 'interface');
  const select = host.querySelector('#ui-language');
  assert.ok(select, 'the actual preferences language selector is mounted');
  assert.equal(dom.document.activeElement, select);
  assert.equal(host.querySelector('.import-notice--inline'), null);
  assert.equal(values.get(KEYS.UI_LANGUAGE_ANNOUNCEMENT), 'dismissed');
  await restart('en-US');
  assert.equal(host.querySelector('.import-notice--inline'), null);
}));

test('F1b valid preference and admission-only language resolution never schedule the banner', async () => surface(async ({ values, KEYS, language, host, restart }) => {
  values.set(KEYS.THEME, 'dark');
  assert.equal(language.loadLanguage('en-US', { persist: false }), 'fr');
  assert.equal(values.has(KEYS.UI_LANGUAGE), false);
  assert.equal(values.has(KEYS.UI_LANGUAGE_ANNOUNCEMENT), false);
  values.set(KEYS.UI_LANGUAGE, 'it');
  assert.equal((await restart('en-US')).resolved, 'it');
  assert.equal(host.querySelector('.import-notice--inline'), null);
}));

test('F1b pending announcement follows FR/EN/IT and remains dismissed if language preference is lost', async () => surface(async ({ values, KEYS, host, initializeI18n, restart }) => {
  values.set(KEYS.THEME, 'dark');
  await restart('en-US');
  for (const [lang, text] of [['fr', 'Changer de langue'], ['en', 'Change language'], ['it', 'Cambia lingua']]) {
    await act(async () => initializeI18n(lang));
    assert.equal(host.querySelector('.import-notice--inline').querySelector('.btn-xs').textContent, text);
  }
  await act(async () => click(host.querySelector('.import-notice-close')));
  values.delete(KEYS.UI_LANGUAGE);
  await restart('en-US');
  assert.equal(host.querySelector('.import-notice--inline'), null);
  assert.equal(values.get(KEYS.UI_LANGUAGE), 'fr');
}));
