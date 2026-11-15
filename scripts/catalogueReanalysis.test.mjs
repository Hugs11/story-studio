import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { installMountedDom, click } from './treeMountedDom.mjs';
import { readFile } from 'node:fs/promises';

test('preferences force all sources once, remain disabled during scans, and translate in FR/EN/IT', async () => {
  const dom = installMountedDom();
  const storage = new Map();
  dom.document.defaultView.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
  const calls = [];
  const sourceState = { items: [], sourcesRevision: 7, loading: false, busy: false, refresh: async () => {} };
  const operationState = { state: { items: {} }, ready: true, start: async (...args) => { calls.push(args); } };
  globalThis.__l22 = { sources: sourceState, operations: operationState };
  const server = await createServer({ configFile: false, plugins: [{ name: 'reanalysis-fixtures', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/useCatalogueSources.js')) return 'export function useCatalogueSources() { return globalThis.__l22.sources; }';
    if (id.endsWith('/useCatalogueOperations.js')) return 'export function useCatalogueOperations() { return globalThis.__l22.operations; }';
    if (id.endsWith('/useCatalogueEntries.js')) return 'export function useCatalogueEntries() { return { cards: [] }; }';
    if (id.endsWith('/useCatalogueSourceActions.js')) return 'export function useCatalogueSourceActions() { return {}; }';
    for (const name of ['SourcesScreen', 'CatalogueNotice', 'CatalogueBackupExport', 'CatalogueBackupImport', 'LuniiPermission']) {
      if (id.endsWith('/' + name + '.jsx')) return 'export function ' + name + '() { return null; }';
    }
    if (id.endsWith('/@tauri-apps/api/path.js')) return 'export async function appDataDir() { return "/data"; } export async function join(...parts) { return parts.join("/"); }';
    return code;
  } }, react()], optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  try {
    const { CatalogueSection } = await server.ssrLoadModule('/src/tabs/OptionsTab/CatalogueSection.jsx');
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    for (const language of ['fr', 'en', 'it']) {
      const engine = initializeI18n(language); await engine.changeLanguage(language);
      const render = async () => { await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, React.createElement(CatalogueSection, { api: {} })))); };
      const button = () => host.querySelectorAll('button').find(node => node.textContent === engine.t('catalogue:preferences.reanalyze.action'));
      operationState.state.items = {}; await render();
      assert.ok(button(), language); assert.equal(button().hasAttribute('disabled'), false);
      assert.ok(host.textContent.includes(engine.t('catalogue:preferences.reanalyze.description')));
      assert.doesNotMatch(host.textContent, /catalogue:preferences.reanalyze/);
      const before = calls.length;
      await act(async () => click(button()));
      assert.equal(calls.length, before + 1);
      assert.deepEqual(calls.at(-1), [7, { force: true }]);
      for (const status of ['queued', 'running', 'cancelling']) {
        operationState.state.items = { scan: { status } }; await render(); assert.equal(button().hasAttribute('disabled'), true, status);
      }
      operationState.state.items = { scan: { status: 'success' } }; await render(); assert.equal(button().hasAttribute('disabled'), false);
    }
  } finally {
    await act(async () => root.unmount()); await server.close(); dom.restore(); delete globalThis.__l22;
  }
});

test('operation hook forwards the optional force flag and IPC adapter keeps the receipt contract', async () => {
  const hook = await readFile(new URL('../src/hooks/useCatalogueOperations.js', import.meta.url), 'utf8');
  assert.match(hook, /force = false/);
  assert.match(hook, /force \? { force: true } : {}/);
  const { createCatalogueApi } = await import('../src/store/catalogue/catalogueApi.js');
  const calls = []; const receipt = { operationId: 'scan', requestId: 'request', sourcesRevision: 7, catalogueRevision: 8 };
  const api = createCatalogueApi({ invoke: async (...args) => { calls.push(args); return receipt; }, listen() {} });
  const request = { force: true, requestId: 'request', expectedSourcesRevision: 7 };
  assert.equal(await api.startScan(request), receipt);
  assert.deepEqual(calls, [['catalogue_start_scan', request]]);
});
