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
const { useCatalogueTrash } = await import('../src/hooks/useCatalogueTrash.js');
function elements(node) { if (!node || typeof node !== 'object') return []; if (Array.isArray(node)) return node.flatMap(elements); return [node, ...elements(node.props?.children)]; }
const find = (tree, predicate) => { const element = elements(tree).find(predicate); assert.ok(element, 'expected control exists'); return element; };
test('trash gesture rejects a double click, cancels a pending plan on reset, and launches ordered confirmations once', async () => {
  let clock = 0; let starts = 0; const stages = []; const released = []; let resolvePlan;
  const plan = { planId: 'p', action: 'deletePermanently', targets: [{ sourceToken: 'target' }] };
  const api = { releasePlan: async id => released.push(id), plan: () => new Promise(resolve => { resolvePlan = resolve; }), confirmRemoval: async (planId, stage) => { stages.push(stage); return { planId, stage, targetToken: 'target', token: stage }; }, start: async () => { starts++; return { operationId: 'op' }; } };
  let flow;
  const app = runner(() => { flow = useCatalogueTrash({ id: 'c' }, { id: 'e' }, { filesApi: api, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: 1 }) }, now: () => clock }); });
  const render = () => { app.render(); app.flush(); };
  try {
    render(); const pending = flow.preview();
    await Promise.resolve(); render(); flow.reset(); render();
    resolvePlan(plan); await pending; render();
    assert.deepEqual(released, ['p']); assert.equal(flow.state.phase, 'choices');
    const next = flow.preview(); await Promise.resolve(); resolvePlan(plan); await next; render();
    await flow.confirm(); clock = 399; await flow.confirm(); assert.equal(starts, 0); assert.deepEqual(stages, []);
    clock = 400; await flow.confirm(); await flow.confirm(); assert.equal(starts, 1); assert.deepEqual(stages, ['targets', 'irreversible']);
  } finally { app.unmount(); }
});

const { useCatalogueSelectionActions } = await import('../src/hooks/useCatalogueSelectionActions.js');
const { SelectionMetadataControls } = await import('../src/components/Catalogue/selection/SelectionControls.jsx');
for (const [Component, props] of [[SelectionMetadataControls, { cards: [] }]]) test(`${Component.name} presents a rejected mutation inside its inline controls`, async () => {
  const api = { mutate: async () => { throw { code: 'CATALOG_REVISION_CONFLICT' }; } };
  let actions;
  const app = runner(() => {
    actions = useCatalogueSelectionActions({ ids: [], cards: [], visibleIds: [], revision: 1, api });
    return Component({ ...props, busy: actions.busy, error: actions.error, mutate: actions.mutate });
  });
  try {
    app.render(); assert.equal(await actions.mutate({ kind: 'test' }), false);
    const tree = app.render(); assert.ok(find(tree, e => e.type === 'p' && e.props.role === 'alert').props.children);
  } finally { app.unmount(); }
});

const { ExemplarTrashButton } = await import('../src/components/Catalogue/fiche/ExemplarTrashButton.jsx');
const { toCatalogueError } = await import('../src/store/catalogue/catalogueApi.js');
test('CORB inline gesture resets on timeout, Escape, outside click and blur; errors stay on the line', async () => {
  const originals = { document: globalThis.document, set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const listeners = new Map(); const timers = new Map(); let nextTimer = 0;
  globalThis.document = { addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: (type, callback) => { if (listeners.get(type) === callback) listeners.delete(type); } };
  globalThis.setTimeout = (callback, ms) => { timers.set(++nextTimer, { callback, ms }); return nextTimer; };
  globalThis.clearTimeout = id => timers.delete(id);
  let expanded = false; let clock = 0; let fail = false; let starts = 0; const prepared = [];
  const services = { now: () => clock, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: 8 }) }, filesApi: {
    plan: async () => { if (fail) throw toCatalogueError({ code: 'CATALOG_FILE_SOURCE_CHANGED' }); return { planId: 'trash-plan', action: 'trash', targets: [{ sourceToken: 'source' }] }; },
    preparePermanentDelete: async id => { prepared.push(id); return { planId: 'delete-plan', action: 'deletePermanently', targets: [{ sourceToken: 'source' }] }; },
    start: async () => { starts++; },
  } };
  const onExpand = id => { expanded = id !== null; };
  const app = runner(() => ExemplarTrashButton({ card: { id: 'c' }, exemplar: { id: 'e' }, expanded, onExpand, onBusy() {}, onDone() {}, services }));
  const render = () => { app.render(); app.flush(); return app.render(); };
  const click = tree => find(tree, e => e.props?.id === 'catalogue-fiche-copy-e-trash').props.onClick({ stopPropagation() {} });
  const settle = async () => { for (let n = 0; n < 15; n++) await Promise.resolve(); };
  try {
    let tree = render(); click(tree); tree = render();
    assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-copy-e-trash').props['aria-disabled'], true);
    await settle(); tree = render();
    assert.ok(elements(tree).some(e => e.props?.className === 'catalogue-exemplar-trash-text' && e.props.children === 'Corbeille ?'), 'libellé court visible');
    assert.deepEqual(prepared, []);
    assert.equal(find(tree, e => e.props?.id === 'catalogue-fiche-copy-e-trash').props['aria-label'], 'Mettre à la corbeille');
    click(tree); assert.equal(starts, 0, 'double click cannot confirm even a completed plan');
    let stopped = false;
    listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() { stopped = true; } });
    assert.equal(expanded, false); assert.equal(stopped, true); render();
    tree = render(); click(tree); render(); await settle(); render();
    const timeout = [...timers.values()].find(timer => timer.ms === 4000); assert.ok(timeout); timeout.callback(); assert.equal(expanded, false); render();
    tree = render(); click(tree); render(); await settle(); render();
    listeners.get('pointerdown')({ target: {} }); assert.equal(expanded, false); render();
    tree = render(); click(tree); tree = render(); await settle(); tree = render();
    find(tree, e => e.props?.className?.startsWith('catalogue-exemplar-trash ')).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: {} });
    assert.equal(expanded, false); render();
    fail = true; tree = render(); click(tree); render(); await settle(); tree = render();
    assert.ok(find(tree, e => e.props?.role === 'alert').props.children);
    assert.ok(!elements(tree).some(e => e.props?.id === 'catalogue-fiche-copy-e-trash'));
    assert.equal(starts, 0); clock = 500;
  } finally {
    app.unmount(); globalThis.document = originals.document; globalThis.setTimeout = originals.set; globalThis.clearTimeout = originals.clear;
  }
});

test('unavailable launch rearms the new label, then a deliberate detail=2 gesture prepares, confirms twice and starts', async () => {
  let clock = 0; let expanded = false; const calls = []; const busy = [];
  const trash = { planId: 'trash', action: 'trash', targets: [{ sourceToken: 'same' }] };
  const now = () => clock;
  const filesApi = {
    plan: async () => trash,
    releasePlan: async () => {},
    preparePermanentDelete: async id => { calls.push(`prepare:${id}`); return { ...trash, planId: 'delete', action: 'deletePermanently' }; },
    confirmRemoval: async (planId, stage) => { calls.push(stage); return { planId, stage, token: stage, targetToken: 'same' }; },
    start: async planId => { calls.push(`start:${planId}`); return { operationId: planId }; },
  };
  const services = { now, filesApi, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: 1 }) }, operationApi: () => ({ getOperation: async id => id === 'trash' ? { status: 'failed', error: { code: 'CATALOG_TRASH_UNAVAILABLE' } } : { status: 'success' } }) };
  const original = globalThis.document;
  globalThis.document = { addEventListener() {}, removeEventListener() {} };
  const app = runner(() => ExemplarTrashButton({ card: { id: 'c' }, exemplar: { id: 'e' }, expanded, onExpand: id => { expanded = id !== null; }, onBusy: value => busy.push(value), onDone() {}, services }));
  const render = () => { app.render(); app.flush(); return app.render(); };
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
  const button = tree => find(tree, e => e.props?.id === 'catalogue-fiche-copy-e-trash');
  const click = tree => button(tree).props.onClick({ detail: 2, stopPropagation() {} });
  try {
    let tree = render(); assert.deepEqual(busy, [], 'mount must not clear another row activity');
    click(tree); render(); await settle(); tree = render();
    clock = 400; click(tree); render(); await settle(); render(); await settle(); tree = render();
    assert.equal(button(tree).props['aria-label'], 'Effacer définitivement');
    assert.deepEqual(calls, ['trash', 'start:trash']);
    clock = 401; click(tree); await settle(); assert.deepEqual(calls, ['trash', 'start:trash']);
    clock = 800; click(tree); render(); await settle(); render(); await settle(); render();
    assert.deepEqual(calls, ['trash', 'start:trash', 'prepare:trash', 'targets', 'irreversible', 'start:delete']);
  } finally { app.unmount(); globalThis.document = original; }
});
