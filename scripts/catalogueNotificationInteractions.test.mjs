import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { useCatalogueActions } = await import('../src/hooks/useCatalogueActions.js');
const { CatalogueMenuItem, CatalogueMenuPanel } = await import('../src/components/Catalogue/menus/CatalogueMenu.jsx');
const { CLOSED_MENU } = await import('../src/store/catalogue/menuState.js');
const { card } = await import('./catalogueFixtures.mjs');
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const find = (tree, predicate) => { const found = elements(tree).find(predicate); assert.ok(found); return found; };

test('copies and successful reveals stay silent; fallback and failures are still reported', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const notices = [], errors = [], writes = [];
  let failCopy = false, failReveal = false, fallback = false, actions;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { if (failCopy) throw new Error('clipboard unavailable'); writes.push(text); } } } });
  const c = card({ title: 'Lune', exemplars: [{ id: 'copy', path: '/Packs/a.zip', uuid: 'uuid' }] });
  const app = runner(() => { actions = useCatalogueActions({ api: { revealExemplar: async () => { if (failReveal) throw new Error('reveal failed'); return { fallbackParentOpened: fallback }; } }, onAnnounce: item => notices.push(item), onError: error => errors.push(error) }); });
  try {
    app.render();
    for (const command of ['copyUuid', 'copyTitle']) assert.equal(await actions.copy(command, c, c.exemplars[0]), true);
    assert.deepEqual(writes, ['uuid', 'Lune']); assert.deepEqual(notices, []);
    await actions.reveal({ card: c, exemplars: c.exemplars, revision: 1 }, c.exemplars[0]);
    assert.deepEqual(notices, []);
    fallback = true;
    await actions.reveal({ card: c, exemplars: c.exemplars, revision: 1 }, c.exemplars[0]);
    assert.equal(notices.length, 1); assert.equal(notices[0].key, 'catalogue:actions.reveal.fallback');
    failCopy = true; assert.equal(await actions.copy('copyUuid', c), false);
    failReveal = true; await actions.reveal({ card: c, exemplars: c.exemplars, revision: 1 }, c.exemplars[0]);
    assert.equal(errors.length, 2); assert.equal(notices.length, 1);
  } finally { app.unmount(); if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator; }
});

for (const command of ['copyUuid']) test(`${command}: mouse and keyboard show local feedback only on success, then close`, async () => {
  const previous = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const timers = new Map(); let next = 0, copies = 0, closes = 0, success = true, item, activate;
  globalThis.setTimeout = (callback, delay) => { timers.set(++next, { callback, delay }); return next; };
  globalThis.clearTimeout = id => timers.delete(id);
  const entry = { key: command, action: { id: command, enabled: true, labelKey: 'catalogue:actions.copyUuid.label' } };
  const app = runner(() => CatalogueMenuItem({ entry, index: 0, active: true, onHover() {}, onActivate: async () => { copies++; return success; }, onCopied: () => { closes++; }, itemRef: element => { item = element; } }));
  const panel = runner(() => CatalogueMenuPanel({ menu: { ...CLOSED_MENU, open: true, activeIndex: 0 }, entries: [entry], dispatch() {}, onActivate() { assert.fail('keyboard must use the same local feedback path as click'); }, children: props => { activate = () => props(0).itemRef(item); return null; } }));
  const render = () => { const tree = app.render(); app.flush(); item = { click: () => tree.props.onClick({ stopPropagation() {} }) }; return tree; };
  try {
    let tree = render();
    tree.props.onClick({ stopPropagation() {} }); await Promise.resolve(); tree = render();
    assert.equal(find(tree, e => e.props?.className === 'catalogue-menu-item-label').props.children, 'Copié');
    assert.equal(closes, 0); assert.equal(timers.size, 1);
    const timer = [...timers.values()][0]; assert.equal(timer.delay, 1000); timers.clear(); timer.callback(); render();
    assert.equal(closes, 1);
    const panelTree = panel.render(); activate();
    panelTree.props.onKeyDown({ key: 'Enter', stopPropagation() {}, preventDefault() {} });
    await Promise.resolve(); tree = render();
    assert.equal(copies, 2); assert.equal(find(tree, e => e.props?.className === 'catalogue-menu-item-label').props.children, 'Copié');
    app.unmount(); assert.equal(timers.size, 0, 'closing a menu cancels its deferred close');
    success = false;
    const failed = runner(() => CatalogueMenuItem({ entry, index: 0, active: true, onHover() {}, onActivate: async () => false, onCopied: () => closes++ }));
    try { const failedTree = failed.render(); failed.flush(); failedTree.props.onClick({ stopPropagation() {} }); await Promise.resolve(); assert.notEqual(find(failed.render(), e => e.props?.className === 'catalogue-menu-item-label').props.children, 'Copié'); assert.equal(timers.size, 0); } finally { failed.unmount(); }
  } finally { app.unmount(); panel.unmount(); globalThis.setTimeout = previous.set; globalThis.clearTimeout = previous.clear; }
});

test('a clipboard reply after closing its menu cannot display feedback or close another menu', async () => {
  const previous = globalThis.setTimeout;
  let finish, timers = 0, closes = 0;
  globalThis.setTimeout = () => { timers++; return 1; };
  const entry = { key: 'late-copy', action: { id: 'copyUuid', enabled: true, labelKey: 'catalogue:actions.copyUuid.label' } };
  const app = runner(() => CatalogueMenuItem({ entry, index: 0, active: true, onHover() {}, onActivate: () => new Promise(resolve => { finish = resolve; }), onCopied: () => closes++ }));
  try {
    const tree = app.render(); app.flush();
    tree.props.onClick({ stopPropagation() {} });
    app.unmount(); finish(true); await Promise.resolve();
    assert.equal(timers, 0); assert.equal(closes, 0);
  } finally { app.unmount(); globalThis.setTimeout = previous; }
});
