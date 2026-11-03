import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { installMountedDom, click } from './treeMountedDom.mjs';
import fixture from './fixtures/select-options-d1-base-sources.json' with { type: 'json' };

// Sources natives extraites par git show 62087fff:<chemin>, avant migration.
async function server(original) {
  return createServer({ configFile: false, plugins: [{ name: 'options-select-fixture', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && fixture.sources[file]) code = fixture.sources[file];
    // Isoler les cinq sections : leurs listes et handlers restent les vrais composants.
    const hooks = {
      useCatalogueSources: '{}', useCatalogueOperations: '{state:{}}',
      useCatalogueEntries: '{cards:[]}', useCatalogueSourceActions: '{}',
      usePiperVoiceOptions: '{}', useXttsVoiceOptions: '{}',
    };
    for (const [name, result] of Object.entries(hooks)) {
      if (id.endsWith(`/${name}.js`)) return `export function ${name}() { return ${result}; }`;
    }
    const children = ['SourcesScreen', 'CatalogueNotice', 'CatalogueBackupExport', 'CatalogueBackupImport', 'LuniiPermission'];
    for (const name of children) if (id.endsWith(`/${name}.jsx`)) return `export function ${name}() { return null; }`;
    // VoiceSection est testée pour sa propre liste ; les deux sous-sections sont montées séparément.
    if (id.endsWith('/VoiceSection.jsx')) code = code.replace(/<(PiperVoiceSettings|XttsVoiceSettings)\b[\s\S]*?\/>/g, '<div />');
    if (id.endsWith('/@tauri-apps/api/path.js')) return 'export async function appDataDir() { return "/data"; } export async function join(...parts) { return parts.join("/"); }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

function mountedDom() {
  const dom = installMountedDom();
  dom.document.defaultView.innerWidth = 1280;
  dom.document.defaultView.innerHeight = 900;
  const storage = new Map();
  dom.document.defaultView.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const create = dom.document.createElement.bind(dom.document);
  dom.document.createElement = name => {
    const element = create(name);
    element.offsetWidth = 180; element.offsetHeight = 30; element.scrollHeight = 240; element.clientHeight = 240;
    element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 180, bottom: 30, width: 180, height: 30 });
    if (name === 'select') {
      Object.defineProperty(element, 'options', { get: () => element.querySelectorAll('option') });
      Object.defineProperty(element, 'value', { get: () => element.options.find(o => o.selected)?.value ?? '', set() {} });
    }
    if (name === 'option') Object.defineProperty(element, 'value', { get: () => element.getAttribute('value') ?? element.textContent, set(value) { element.setAttribute('value', value); } });
    return element;
  };
  dom.document.getElementById = id => dom.document.body.querySelectorAll('*').find(n => n.getAttribute('id') === id) ?? null;
  return dom;
}

const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const text = node => node.textContent.replace(/\s+/g, ' ').trim();
function key(node, value) {
  node.dispatchEvent({ type: 'keydown', key: value, bubbles: true, preventDefault() {}, stopPropagation() { this.cancelBubble = true; } });
}
async function mount(dom, component, props, engine) {
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(component, props))));
  await settle();
  return { host, close: async () => { await act(async () => root.unmount()); dom.document.body.removeChild(host); } };
}
async function lists(dom, component, props, engine, original) {
  const h = await mount(dom, component, props, engine);
  try {
    if (original) return h.host.querySelectorAll('select').map(select => select.querySelectorAll('option').map(text));
    assert.equal(h.host.querySelectorAll('select').length, 0);
    const result = [];
    for (const trigger of h.host.querySelectorAll('.select-trigger')) {
      assert.ok(trigger.getAttribute('aria-label'), 'nom accessible');
      await act(async () => key(trigger, 'ArrowDown')); await settle();
      assert.equal(trigger.getAttribute('aria-expanded'), 'true');
      result.push(dom.document.body.querySelectorAll('.select-option').map(text));
      await act(async () => key(trigger, 'Escape')); await settle();
      assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    }
    return result;
  } finally { await h.close(); }
}

const piperProps = {
  piperVoices: [{ id: 'a', label: 'Voix été', language: 'fr', installed: true }, { id: 'b', label: 'Voix à télécharger', language: 'fr', installed: false }, { id: 'c', label: 'English', language: 'en', installed: true }],
  piperProvision: { state: 'idle' }, piperLanguage: 'fr', piperVoice: 'a', piperSpeed: 1,
};
const xttsProps = { xttsSettings: { language: 'fr', serverUrl: '', xttsDir: '' }, xttsProbe: { state: 'idle' }, xttsLogs: [], favoriteVoices: [], xttsVoices: [] };

test('Options : les sept listes ouvertes gardent les options de 62087fff, dans le même ordre, FR/EN/IT', async () => {
  const dom = mountedDom();
  const current = await server(false), original = await server(true);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js');
    const cases = [
      ['InterfaceSection', { themePreference: 'system' }, 2],
      ['CatalogueSection', {}, 1],
      ['VoiceSection', { xttsSettings: { backend: 'piper' } }, 1],
      ['PiperVoiceSettings', piperProps, 2],
      ['XttsVoiceSettings', xttsProps, 1],
    ];
    for (const language of ['fr', 'en', 'it']) {
      const engine = initializeI18n(language); await engine.changeLanguage(language);
      let count = 0;
      for (const [name, props, size] of cases) {
        const path = `/src/tabs/OptionsTab/${name}.jsx`;
        const old = (await original.ssrLoadModule(path))[name], now = (await current.ssrLoadModule(path))[name];
        const expected = await lists(dom, old, props, engine, true);
        assert.equal(expected.length, size, name);
        assert.ok(expected.every(options => options.length >= 2), name);
        assert.deepEqual(await lists(dom, now, props, engine, false), expected, `${name}/${language}`);
        count += size;
      }
      assert.equal(count, 7);
    }
  } finally { await current.close(); await original.close(); dom.restore(); }
});

test('Options : choix au clavier et au clic transmettent les valeurs, Piper vide reste désactivé', async () => {
  const dom = mountedDom(), current = await server(false);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const cases = [
      ['InterfaceSection', { themePreference: 'system' }, 'onThemePreferenceChange', 1, 'End', 'light'],
      ['VoiceSection', { xttsSettings: { backend: 'piper' } }, 'onUpdateXttsSettings', 0, 'End', { backend: 'xtts', enabled: true }],
      ['PiperVoiceSettings', piperProps, 'updatePiperLanguage', 0, 'End', 'it_IT'],
      ['PiperVoiceSettings', piperProps, 'updatePiperVoice', 1, 'End', 'b'],
      ['XttsVoiceSettings', xttsProps, 'updateLanguage', 0, 'End', 'pt'],
    ];
    for (const [name, props, handler, index, direction, expected] of cases) {
      const component = (await current.ssrLoadModule(`/src/tabs/OptionsTab/${name}.jsx`))[name];
      for (const method of ['keyboard', 'click']) {
        const calls = [];
        const h = await mount(dom, component, { ...props, [handler]: value => calls.push(value) }, engine);
        try {
          const trigger = h.host.querySelectorAll('.select-trigger')[index];
          await act(async () => key(trigger, 'ArrowDown')); await settle();
          if (method === 'keyboard') {
            await act(async () => key(trigger, direction));
            await act(async () => key(trigger, 'Enter'));
          } else await act(async () => click(dom.document.body.querySelectorAll('.select-option').at(-1)));
          assert.deepEqual(calls, [expected], `${name}/${handler}/${method}`);
          assert.equal(trigger.getAttribute('aria-expanded'), 'false');
          assert.equal(dom.document.activeElement, trigger);
        } finally { await h.close(); }
      }
    }
    const { PiperVoiceSettings } = await current.ssrLoadModule('/src/tabs/OptionsTab/PiperVoiceSettings.jsx');
    const h = await mount(dom, PiperVoiceSettings, { ...piperProps, piperVoices: [] }, engine);
    try {
      assert.equal(h.host.querySelectorAll('.select-trigger').length, 2);
      assert.ok(h.host.querySelectorAll('.select-trigger').every(trigger => trigger.hasAttribute('disabled')));
      assert.ok(h.host.textContent.includes('a'), 'voix de repli conservée');
    } finally { await h.close(); }
  } finally { await current.close(); dom.restore(); }
});

test('Options : les choix de langue et de page de démarrage enregistrent leurs valeurs', async () => {
  const dom = mountedDom(), current = await server(false);
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { KEYS, read } = await current.ssrLoadModule('/src/store/persistentSettings.js');
    for (const [name, props, index, position, setting, expected] of [
      ['InterfaceSection', { themePreference: 'system' }, 0, 1, KEYS.UI_LANGUAGE, 'en'],
      ['CatalogueSection', {}, 0, 1, KEYS.CATALOGUE_STARTUP_PAGE, 'catalogue'],
    ]) {
      const component = (await current.ssrLoadModule(`/src/tabs/OptionsTab/${name}.jsx`))[name];
      const h = await mount(dom, component, props, engine);
      try {
        const trigger = h.host.querySelectorAll('.select-trigger')[index];
        await act(async () => click(trigger)); await settle();
        await act(async () => click(dom.document.body.querySelectorAll('.select-option')[position])); await settle();
        assert.equal(read(setting), expected, name);
        if (name === 'InterfaceSection') assert.equal(engine.language, 'en');
        else assert.equal(trigger.textContent, engine.t('catalogue:startup.page.catalogue'));
      } finally { await h.close(); }
    }
  } finally { await current.close(); dom.restore(); }
});
