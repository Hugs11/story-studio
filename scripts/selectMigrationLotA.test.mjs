import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { withBaseSourceAliases } from './baseSourceAliases.mjs';
import { installMountedDom, click } from './treeMountedDom.mjs';
import { sources } from './i18nAiSourceFixture.mjs';
import treeFixture from './fixtures/tree-fields-fr-base-sources.json' with { type: 'json' };
import { applyLot413 } from './i18nLot413Corrections.mjs';

// Équivalence des listes migrées du natif vers le composant Select : la liste ordonnée des <option> de la source
// d'origine (git show BASE, jamais le nouveau code) est comparée à celle des options du Select ouvert.

async function server(original) {
  return createServer({ configFile: false, plugins: [{ name: 'select-migration-fixture', enforce: 'pre', transform(code, id) {
    const file = id.slice(id.indexOf('/src/') + 1);
    if (original && sources[file]) code = sources[file];
    if (original && treeFixture.sources[file]) code = treeFixture.sources[file];
    if (original) code = withBaseSourceAliases(code, id);
    if (id.includes('/@tauri-apps/api/') && id.endsWith('/core.js')) return 'export function invoke(command, params) { return globalThis.__selectInvoke(command, params); } export function convertFileSrc(path) { return path; }';
    if (id.endsWith('/useLocalFile.js')) return 'export function useLocalFile(path) { return path; }';
    if (id.endsWith('/ProjectContext.js')) return 'export function useProjectContext() { return {workspaceDir:""}; }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
}

// Le DOM minimal partagé ne simule pas encore les options d'un select natif (comme i18nAiMounted.test.mjs).
function mountedDom() {
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
  // Select retrouve l'option active par id.
  dom.document.getElementById = id => dom.document.body.querySelectorAll('*').find(n => n.attributes.id === id) ?? null;
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: (command, params) => globalThis.__selectInvoke?.(command, params) };
  return dom;
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const texts = nodes => nodes.map(n => n.textContent.replace(/\s+/g, ' ').trim());

// Monte `element` et renvoie, pour chaque liste, ses textes d'options : natives (<option>) ou Select ouvert.
async function optionLists(dom, element, { engine = null } = {}) {
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(engine ? React.createElement(I18nextProvider, { i18n: engine }, element) : element));
    await settle();
    const natives = host.querySelectorAll('select');
    if (natives.length > 0) return natives.map(select => texts(select.querySelectorAll('option')));
    const lists = [];
    for (const trigger of host.querySelectorAll('.select-trigger')) {
      await act(async () => click(trigger)); await settle();
      lists.push(texts(dom.document.body.querySelectorAll('.select-option')));
      await act(async () => click(trigger)); await settle();
    }
    return lists;
  } finally { await act(async () => root.unmount()); }
}

test('GenerateVoiceModal Piper et XTTS : options des listes identiques à la source BASE, dans l’ordre', async () => {
  const dom = mountedDom();
  const current = await server(false), original = await server(true);
  globalThis.__selectInvoke = (command) => {
    if (command === 'piper_list_voices') return Promise.resolve({ binaryInstalled: true, defaultLanguage: 'fr', defaultVoice: 'fr_A', voices: [
      { id: 'fr_A', label: 'Voix A', language: 'fr', quality: 'medium', isDefault: true, installed: true },
      { id: 'fr_B', label: 'Voix B', language: 'fr', quality: 'medium', isDefault: false, installed: false },
      { id: 'en_C', label: 'Voice C', language: 'en', quality: 'medium', isDefault: false, installed: true },
    ] });
    if (command === 'xtts_get_status') return Promise.resolve({ voices: ['Alice', 'Bob'], device: 'cpu' });
    return Promise.resolve();
  };
  dom.document.defaultView.__TAURI_INTERNALS__ = { invoke: (command, params) => globalThis.__selectInvoke(command, params) };
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const now = (await current.ssrLoadModule('/src/components/GenerateVoiceModal/GenerateVoiceModal.jsx')).GenerateVoiceModal;
    const old = (await original.ssrLoadModule('/src/components/GenerateVoiceModal/GenerateVoiceModal.jsx')).GenerateVoiceModal;
    for (const backend of ['piper', 'xtts']) {
      const props = { xttsSettings: { backend, language: 'fr', piperLanguage: 'fr', piperVoice: 'fr_A' }, label: '_AUTHOR_LABEL_', initialText: '_AUTHOR_TEXT_', onQueueGenerate() {}, onClose() {} };
      const expected = (await optionLists(dom, React.createElement(old, props))).map(list => list.map(text => applyLot413(text)));
      const actual = await optionLists(dom, React.createElement(now, props), { engine });
      assert.equal(expected.length, 2, `${backend} : deux listes natives à l'origine`);
      assert.ok(expected.every(list => list.length >= 2), `${backend} : listes non vides`);
      assert.deepEqual(actual, expected, backend);
    }
  } finally { await current.close(); await original.close(); dom.restore(); delete globalThis.__selectInvoke; }
});

test('MissingMediaRelinkModal : options = [placeholder, ...correspondances] dans l’ordre, et le choix résout la ligne', async () => {
  const dom = mountedDom();
  const current = await server(false);
  // Les plugins Tauri sont externalisés : leurs commandes IPC sont simulées.
  const tree = {
    '/ws': [{ name: 'a', isDirectory: true }, { name: 'b', isDirectory: true }],
    '/ws/a': [{ name: 'x.wav', isFile: true }],
    '/ws/b': [{ name: 'x.wav', isFile: true }],
  };
  globalThis.__selectInvoke = (command, params) => {
    if (command === 'plugin:dialog|open') return Promise.resolve('/ws');
    if (command === 'plugin:fs|exists') return Promise.resolve(false);
    if (command === 'plugin:fs|read_dir') return Promise.resolve(tree[params.path] ?? []);
    return Promise.resolve();
  };
  try {
    const { initializeI18n } = await current.ssrLoadModule('/src/i18n/index.js'); const engine = initializeI18n('fr');
    const { MissingMediaRelinkModal } = await current.ssrLoadModule('/src/components/MissingMediaRelink/MissingMediaRelinkModal.jsx');
    const missingMedia = [{ path: '/old/x.wav', fileName: 'x.wav', kind: 'audio', labels: [] }, { path: '/old/y.wav', fileName: 'y.wav', kind: 'audio', labels: [] }];
    const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(MissingMediaRelinkModal, { missingMedia, onApply() {}, onClose() {} }))));
    await act(async () => click(dom.document.body.querySelector('.relink-gbtn'))); await settle();
    const trigger = dom.document.body.querySelector('.relink-row-select');
    assert.ok(trigger, 'ligne ambiguë : liste de correspondances affichée');
    await act(async () => click(trigger)); await settle();
    const labels = texts(dom.document.body.querySelectorAll('.select-option'));
    assert.deepEqual(labels, [engine.t('media:relink.match.placeholder'), '/ws/a/x.wav', '/ws/b/x.wav']);
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[2])); await settle();
    assert.ok(dom.document.body.querySelector('.is-found'), 'choisir une correspondance résout la ligne');
    assert.equal(dom.document.body.querySelector('.relink-row-select'), null, 'la liste disparaît une fois la ligne résolue');
    await act(async () => root.unmount());
  } finally { await current.close(); dom.restore(); delete globalThis.__selectInvoke; }
});
