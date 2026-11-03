import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';

test('catalogue departure preserves refused fiche edits and waits for their save', async () => {
  const fixture = { guard: null, chrome: null, browser: null };
  globalThis.__catalogueLeaveTest = fixture;
  const server = await createServer({ configFile: false, plugins: [{
    name: 'catalogue-leave-boundaries', enforce: 'pre',
    transform(_code, id) {
      if (id.endsWith('/useCatalogueSources.js')) return 'export function useCatalogueSources() { return { items: [], loading: false }; }';
      if (id.endsWith('/useCatalogueOperations.js')) return 'export function useCatalogueOperations() { return { state: { items: {} }, ready: true }; }';
      if (id.endsWith('/useCatalogueEntries.js')) return 'export function useCatalogueEntries() { return { cards: [], status: "ready" }; }';
      if (id.endsWith('/CatalogueBrowser.jsx')) return `
        export function CatalogueBrowser(props) {
          const fixture = globalThis.__catalogueLeaveTest;
          fixture.browser = props;
          if (props.abandonGuard) props.abandonGuard.current = fixture.guard;
          return props.renderHeader({});
        }`;
      if (id.endsWith('/CatalogueChrome.jsx')) return `
        export const CATALOGUE_MENU_ID = 'catalogue-menu';
        export function CatalogueChrome(props) { globalThis.__catalogueLeaveTest.chrome = props; return null; }`;
    },
  }, react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const previousFrame = globalThis.requestAnimationFrame;
  const frames = [];
  globalThis.requestAnimationFrame = callback => frames.push(callback);
  try {
    const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
    initializeI18n('fr');
    const { CatalogueScreen } = await server.ssrLoadModule('/src/components/Catalogue/CatalogueScreen.jsx');
    const { ErrorDialogProvider } = await server.ssrLoadModule('/src/components/common/Dialog.jsx');
    let departures = 0;
    const render = guard => {
      fixture.guard = guard;
      renderToStaticMarkup(React.createElement(ErrorDialogProvider, null,
        React.createElement(CatalogueScreen, { onClose: () => { departures += 1; } })));
    };
    for (const reason of ['invalid', 'conflict', 'save refused']) {
      render(async () => false);
      await fixture.chrome.onHome();
      assert.equal(departures, 0, `${reason}: catalogue must stay mounted`);
      assert.equal(frames.length, 0, `${reason}: focus must stay in the catalogue`);
    }
    let finish;
    render(() => new Promise(resolve => { finish = resolve; }));
    const leaving = fixture.chrome.onHome();
    assert.equal(departures, 0, 'save must finish before unmounting the fiche');
    finish(true);
    await leaving;
    assert.equal(departures, 1);
    assert.equal(frames.length, 1);
    render(null);
    fixture.chrome.onHome();
    assert.equal(departures, 2, 'no editor: departure is synchronous');
    render(async () => true);
    await fixture.chrome.onHome();
    assert.equal(departures, 3, 'unchanged fiche permits departure');
    render(async () => false);
    const framesBeforeLanding = frames.length;
    await fixture.browser.onAssemblyLanded();
    // Product decision: the fiche guard moves to both assembly launch paths.
    // Successful landing has already installed the project and closes directly.
    assert.equal(departures, 4, 'successful assembly landing bypasses the fiche guard');
    assert.equal(frames.length, framesBeforeLanding, 'assembly landing does not run the Home focus path');
  } finally {
    if (previousFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousFrame;
    delete globalThis.__catalogueLeaveTest;
    await server.close();
  }
});

test('browser shares its fiche editor guard with catalogue departures', () => {
  const browser = readFileSync(new URL('../src/components/Catalogue/CatalogueBrowser.jsx', import.meta.url), 'utf8');
  assert.match(browser, /const ficheAbandon = abandonGuard \?\? localAbandon/);
  assert.match(browser, /abandonGuard=\{ficheAbandon\}/);
});

test('both assembly launch paths refuse invalid drafts, await saving and protect background editing', async (t) => {
  const { registerHooks } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const { transformSync } = await import('rolldown/experimental');
  const { runner } = await import('./reactHookDriver.mjs');
  await import('./chromeBench.mjs');
  const driverUrl = new URL('./reactHookDriver.mjs', import.meta.url).href;
  const reactModuleUrl = new URL('../node_modules/react/index.js', import.meta.url).href;
  const reactUrl = `data:text/javascript,${encodeURIComponent(`export * from '${reactModuleUrl}'; export { default } from '${reactModuleUrl}'; export { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, useReducer, useContext, useId } from '${driverUrl}'; export function useSyncExternalStore(_subscribe, snapshot) { return snapshot(); }`)}`;
  const fixture = { state: { phase: 'idle' }, starts: [], start(selection) { this.starts.push(selection); }, close() {} };
  globalThis.__assemblyLaunchTest = fixture;
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'react') return { url: reactUrl, shortCircuit: true };
      if (specifier.startsWith('.') && context.parentURL) {
        for (const suffix of ['.js', '.jsx', '/index.js', '/index.jsx']) {
          const candidate = new URL(`${specifier}${suffix}`, context.parentURL);
          if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
        }
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.endsWith('/useCatalogueAssembly.js')) return { format: 'module', source: 'export function useCatalogueAssembly() { return globalThis.__assemblyLaunchTest; }', shortCircuit: true };
      if (url.endsWith('/useCatalogueRemoval.js')) return { format: 'module', source: 'export function useCatalogueRemoval() { return () => { throw new Error("unexpected removal"); }; }', shortCircuit: true };
      if (url.endsWith('.jsx')) return { format: 'module', source: `import InteractionReact from '${reactModuleUrl}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8').replaceAll('import.meta.env.DEV', 'false'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
      return next(url, context);
    },
  });
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const focusLog = [];
  const target = id => ({ id, isConnected: true, focus() { globalThis.document.activeElement = this; focusLog.push(id); } });
  const trigger = target('selection-assemble'), menuTrigger = target('card-a'), search = target('catalogue-search'), funnelClose = target('funnel-close');
  globalThis.document = {
    activeElement: trigger,
    getElementById: id => id === menuTrigger.id ? menuTrigger : id === search.id ? search : null,
    querySelector: selector => selector === '.funnel-modal .funnel-icon-btn' ? funnelClose : null,
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  let app, browseSession;
  try {
    const { CatalogueBrowser } = await import('../src/components/Catalogue/CatalogueBrowser.jsx');
    ({ browseSession } = await import('../src/store/catalogue/browseSession.js'));
    const { card } = await import('./catalogueFixtures.mjs');
    const cards = [card({ id: 'a', title: 'A' }), card({ id: 'b', title: 'B' })];
    browseSession.save({ view: 'cards', ficheId: 'a', selection: { ids: ['a', 'b'], anchorId: 'a' }, activeId: 'a' });
    const guard = { current: async () => false };
    app = runner(() => CatalogueBrowser({ abandonGuard: guard, cards, revision: 1, api: {}, onError: error => { throw error; }, renderEmpty: () => null }));
    const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
    const find = (tree, predicate) => { const found = elements(tree).find(predicate); assert.ok(found); return found; };
    const render = () => app.render(); // Effects/IPC are outside this gesture test.
    const selectionLaunch = () => find(render(), e => e.props?.onSelectionAction).props.onSelectionAction('assemble');
    const menuLaunch = () => {
      const tree = render();
      const view = find(tree, e => e.props?.view?.onCardMenu);
      view.props.view.onCardMenu({ preventDefault() {}, currentTarget: { id: 'card-a' }, type: 'keydown' }, view.props.items[0]);
      const menu = find(render(), e => e.type?.name === 'CardContextMenu');
      const entry = menu.props.entries.find(e => e.action?.id === 'assemble');
      assert.ok(entry?.action.enabled);
      menu.props.onActivate(entry);
    };
    const tick = () => new Promise(resolve => setImmediate(resolve));
    for (const launch of [selectionLaunch, menuLaunch]) {
      const before = fixture.starts.length;
      guard.current = async () => false;
      launch(); await tick();
      assert.equal(fixture.starts.length, before, 'invalid fiche refuses the launch');
      let saved;
      guard.current = () => new Promise(resolve => { saved = resolve; });
      launch(); await tick();
      assert.equal(fixture.starts.length, before, 'assistant must wait for the fiche save');
      saved(true); await tick();
      assert.equal(fixture.starts.length, before + 1);
      assert.deepEqual(fixture.starts.at(-1).map(item => item.ficheId), ['a', 'b']);
      const assistant = find(render(), e => e.type?.name === 'CatalogueAssembly');
      assert.equal(assistant.props.returnFocus.current.trigger, launch === menuLaunch ? menuTrigger : trigger);
    }
    for (const phase of ['idle', 'preparing', 'ready', 'error']) {
      fixture.state = { phase };
      const tree = render();
      const results = find(tree, e => e.props?.className === 'catalogue-results');
      // showModal contains preparation/errors; only the ready portal needs inert.
      assert.equal(results.props.inert, phase === 'ready', 'preparation cleanup can restore focus before the ready assistant takes it');
      assert.ok(elements(results).some(e => e.props?.onSelectionAction), 'the fiche remains inside the protected boundary');
      const assistant = find(tree, e => e.type?.name === 'CatalogueAssembly');
      assert.equal(elements(results).includes(assistant), false, 'the assistant itself remains interactive');
    }
    await t.test('preparation cleanup is followed by initial focus in the ready assistant', async () => {
      const { CatalogueAssembly } = await import('../src/components/Catalogue/assembly/CatalogueAssembly.jsx');
      const { ContentDialog } = await import('../src/components/common/ContentDialog.jsx');
      const state = { state: { phase: 'preparing' }, close() {} };
      const returnFocus = { current: { trigger } };
      const assistant = runner(() => CatalogueAssembly({ assembly: state, returnFocus }));
      const preparation = runner(() => ContentDialog({ label: 'Preparation', onClose() {} }));
      const nativeDialog = { showModal() { document.activeElement = this; }, close() {} };
      try {
        document.activeElement = trigger;
        assistant.render(); assistant.flush();
        preparation.render().props.ref.current = nativeDialog; preparation.flush();
        assert.equal(document.activeElement, nativeDialog);
        state.state = { phase: 'ready' };
        assistant.render();
        preparation.unmount(); // Real native-dialog cleanup restores its trigger.
        assert.equal(document.activeElement, trigger);
        assistant.flush();
        assert.equal(document.activeElement, funnelClose);
        assert.deepEqual(focusLog.slice(-2), [trigger.id, funnelClose.id]);
      } finally { preparation.unmount(); assistant.unmount(); }
    });
    await t.test('cancelling the ready assistant restores its connected trigger', async () => {
      const { CatalogueAssembly } = await import('../src/components/Catalogue/assembly/CatalogueAssembly.jsx');
      const state = { state: { phase: 'ready' }, close() {} };
      const returnFocus = { current: { trigger: menuTrigger } };
      const assistant = runner(() => CatalogueAssembly({ assembly: state, returnFocus }));
      try {
        assistant.render(); assistant.flush();
        assert.equal(document.activeElement, funnelClose);
        state.state = { phase: 'idle' };
        assert.equal(assistant.render(), null); assistant.flush();
        assert.equal(document.activeElement, menuTrigger);
        assert.equal(returnFocus.current, null);
      } finally { assistant.unmount(); }
    });
    await t.test('cancelling an error restores search if the original trigger disappeared', async () => {
      const { CatalogueAssembly } = await import('../src/components/Catalogue/assembly/CatalogueAssembly.jsx');
      const state = { state: { phase: 'preparing' }, close() {} };
      const returnFocus = { current: { trigger: { ...trigger, isConnected: false } } };
      const assistant = runner(() => CatalogueAssembly({ assembly: state, returnFocus }));
      try {
        assistant.render(); assistant.flush();
        state.state = { phase: 'error' }; assistant.render(); assistant.flush();
        state.state = { phase: 'idle' }; assistant.render(); assistant.flush();
        assert.equal(document.activeElement, search);
      } finally { assistant.unmount(); }
    });
    await t.test('an opened issue journal stays mounted after an empty response', async () => {
      const { OperationIssues } = await import('../src/components/Catalogue/operations/OperationIssues.jsx');
      const { translateCatalogue } = await import('../src/i18n/cataloguePresentation.js');
      const api = { getOperation: async () => ({ items: [] }) };
      const issues = runner(() => OperationIssues({ operationId: 'empty', snapshot: { error: { code: 'CATALOG_STORE_UNAVAILABLE' }, outcomes: { error: 1 } }, api }));
      try {
        const initial = issues.render(); issues.flush();
        initial.props.onToggle({ currentTarget: { open: true } });
        issues.render(); issues.flush(); await tick();
        const loaded = issues.render();
        assert.equal(loaded.type, 'details');
        assert.equal(find(loaded, e => e.type === 'summary').type, find(initial, e => e.type === 'summary').type);
        assert.ok(elements(loaded).some(e => e.type === 'p' && e.props.children === translateCatalogue('catalogue:diagnostics.none')));
      } finally { issues.unmount(); }
    });
  } finally {
    app?.unmount(); hooks.deregister();
    browseSession?.clear();
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    delete globalThis.__assemblyLaunchTest;
  }
});
