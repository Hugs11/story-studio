import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { createLuniiDevices } from '../src/store/catalogue/luniiDevices.js';
import { createLuniiGestures } from '../src/store/catalogue/luniiGestures.js';
import { describeLuniiActivity } from '../src/store/luniiCloseGuard.js';
registerHooks({ load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { LuniiPanelHeader } = await import('../src/components/Catalogue/lunii/LuniiPanelHeader.jsx');
const { LuniiQueuedCancel } = await import('../src/components/Catalogue/lunii/LuniiQueuedMark.jsx');
const { Button } = await import('../src/components/common/Button.jsx');
const { Tooltip } = await import('../src/components/common/Tooltip.jsx');
const t = createTestI18n().getFixedT('fr');

// Short delays (polls, retries) run at once; the waiting bounds never fire here.
const timers = { setTimeout: (fn, ms) => { if (ms <= 500) queueMicrotask(fn); return null; }, clearTimeout() {} };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, ko) => { resolve = ok; reject = ko; }); return { promise, resolve, reject }; };
const detail = id => ({ id, name: 'Chambre', state: 'ready', busy: false, inspected: true, stories: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }], orphans: [], banner: [] });

async function fixture(overrides = {}) {
  const calls = [];
  const engine = { busy: false };
  const api = {
    list: async () => [{ id: 'd', busy: engine.busy }, { id: 'e', busy: false }],
    inspect: async id => detail(id),
    getOperation: async () => ({ status: 'success' }),
    rename: async (id, name) => { calls.push(['rename', id, name]); return { device: detail(id) }; },
    remove: async (id, keys) => { calls.push(['remove', id, keys]); return { device: detail(id) }; },
    eject: async id => { calls.push(['eject', id]); },
    cancel: async () => { calls.push(['nativeCancel']); },
    ...overrides,
  };
  const store = createLuniiDevices(api, { read() {}, write() {} }, timers, async () => '/w');
  store.reconcile([{ id: 'd', state: 'detected' }, { id: 'e', state: 'detected' }]);
  await store.inspect('d'); await store.inspect('e');
  const device = (id = 'd') => store.getSnapshot().luniiDevices.find(d => d.id === id);
  return { store, api, calls, engine, device };
}
// A write that holds the queue until released by the test.
function blockingSend(store, id = 'd') {
  const gate = deferred();
  const handle = store.enqueueSend(id, { title: 'Long' }, async () => { await gate.promise; return {}; }, () => {}, () => null);
  return { gate, handle };
}
function gesturesFor(store, answer) {
  const asked = [], said = [];
  const gestures = createLuniiGestures({ store }, t, async () => true, text => said.push(text), async dialog => { asked.push(dialog); return answer; });
  return { gestures, asked, said };
}

test('a Lunii with nothing running is ejected at once, without a question', async () => {
  const { store, calls, device } = await fixture();
  const { gestures, asked } = gesturesFor(store, 'stay');
  await gestures.eject(device());
  assert.equal(asked.length, 0);
  assert.deepEqual(calls, [['eject', 'd']]);
  assert.equal(device().state, 'ejected');
});

test('ejecting during the queue asks in the app style what remains, « Attendre la fin » first and focused', async () => {
  const { store, device } = await fixture();
  const { gate } = blockingSend(store);
  void store.mutate('d', 'rename', ['Salon']); void store.mutate('d', 'remove', [['a']], ['a']);
  await tick();
  const { gestures, asked } = gesturesFor(store, 'stay');
  await gestures.eject(device());
  assert.equal(asked.length, 1);
  const [dialog] = asked;
  assert.equal(dialog.title, 'Éjecter la Lunii ?');
  assert.match(dialog.message, /Il reste 3 opérations sur la Lunii, dont celle en cours, qui finit toujours/);
  assert.deepEqual(dialog.actions.map(a => [a.value, a.label, a.kind ?? null, !!a.autoFocus]), [
    ['wait', 'Attendre la fin', 'primary', true], ['cancelRest', 'Annuler le reste', 'danger-outline', false], ['stay', 'Ne pas éjecter', null, false]]);
  assert.equal(dialog.cancelValue, 'stay');
  assert.notEqual(device().ejectPending, true, '« Ne pas éjecter » changes nothing');
  gate.resolve();
});

test('with only the running write left, « Annuler le reste » is not offered', async () => {
  const { store, device } = await fixture();
  const { gate } = blockingSend(store);
  await tick();
  const { gestures, asked } = gesturesFor(store, 'stay');
  await gestures.eject(device());
  assert.deepEqual(asked[0].actions.map(a => a.value), ['wait', 'stay']);
  assert.match(asked[0].message, /Une opération est en cours sur la Lunii ; elle finit toujours/);
  gate.resolve();
});

test('« Attendre la fin »: everything waiting runs, then the Lunii is ejected once, and it is announced', async () => {
  const { store, calls, device } = await fixture();
  const { gate, handle } = blockingSend(store);
  const rename = store.mutate('d', 'rename', ['Salon']);
  await tick();
  const { gestures, said } = gesturesFor(store, 'wait');
  await gestures.eject(device());
  assert.equal(device().ejectPending, true);
  assert.deepEqual(said, ['Éjection à la fin des opérations']);
  await tick();
  assert.deepEqual(calls, [], 'nothing ejected while the queue runs');
  gate.resolve(); await Promise.all([handle.finished, rename]); await tick();
  assert.deepEqual(calls, [['rename', 'd', 'Salon'], ['eject', 'd']]);
  assert.equal(device().state, 'ejected'); assert.equal(device().ejectPending, false);
});

test('« Annuler le reste »: only this Lunii\'s waiting entries are cancelled, the running one finishes uncut, then ejection', async () => {
  const { store, calls, device } = await fixture();
  const { gate, handle } = blockingSend(store);
  const dropped = store.mutate('d', 'rename', ['Salon']);
  const other = blockingSend(store, 'e');
  const elsewhere = store.mutate('e', 'rename', ['Ailleurs']);
  await tick();
  const { gestures } = gesturesFor(store, 'cancelRest');
  await gestures.eject(device());
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['running', 'cancelled']);
  assert.deepEqual(store.getQueueReport().e.map(e => e.state), ['running', 'queued'], 'the other Lunii keeps its queue');
  gate.resolve(); await Promise.all([handle.finished, dropped]); await tick();
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['done', 'cancelled']);
  assert.deepEqual(calls, [['eject', 'd']], 'no native cancellation, no cancelled write');
  other.gate.resolve(); await Promise.all([other.handle.finished, elsewhere]);
});

test('a gesture made while the ejection waits is queued and done before it (same rule as every gesture)', async () => {
  const { store, calls, device } = await fixture();
  const { gate, handle } = blockingSend(store);
  await tick();
  store.ejectWhenIdle('d');
  const late = store.mutate('d', 'remove', [['b']], ['b']);
  gate.resolve(); await Promise.all([handle.finished, late]); await tick();
  assert.deepEqual(calls, [['remove', 'd', ['b']], ['eject', 'd']]);
  assert.equal(device().state, 'ejected');
});

test('a stopped Lunii still reserved by the engine is ejected only once the inventory shows it free', async () => {
  const fault = { code: 'STORYTELLER_DEVICE_UNRESPONSIVE', params: {}, deviceFault: true };
  const { store, calls, engine, device } = await fixture({ rename: async () => { throw fault; } });
  engine.busy = true;
  const stuck = blockingSend(store);
  const failing = store.mutate('d', 'rename', ['Salon']);
  const after = store.mutate('d', 'remove', [['a']], ['a']);
  await tick();
  store.ejectWhenIdle('d');
  engine.busy = false; stuck.gate.resolve(); await stuck.handle.finished; engine.busy = true;
  await Promise.all([failing, after]); await tick();
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['done', 'failed', 'notStarted']);
  assert.deepEqual(calls.filter(call => call[0] === 'eject'), [], 'still reserved: no ejection attempt');
  assert.equal(device().ejectPending, true, 'the wait goes on, and can be cancelled');
  store.reconcile([{ id: 'd', state: 'ready', busy: true }, { id: 'e', state: 'ready', busy: false }]); await tick();
  assert.deepEqual(calls.filter(call => call[0] === 'eject'), []);
  engine.busy = false;
  store.reconcile([{ id: 'd', state: 'ready', busy: false }, { id: 'e', state: 'ready', busy: false }]); await tick();
  assert.deepEqual(calls.filter(call => call[0] === 'eject'), [['eject', 'd']]);
});

test('unplugged while the ejection waits: the wait is dropped, and a replug never ejects', async () => {
  const { store, calls, device } = await fixture();
  const { gate } = blockingSend(store);
  await tick();
  store.ejectWhenIdle('d');
  store.reconcile([{ id: 'e', state: 'ready', busy: false }]);
  assert.equal(device().state, 'disconnected'); assert.equal(device().ejectPending, false);
  gate.resolve(); await tick();
  store.reconcile([{ id: 'd', state: 'ready', busy: false }, { id: 'e', state: 'ready', busy: false }]); await tick();
  assert.deepEqual(calls.filter(call => call[0] === 'eject'), []);
  assert.notEqual(device().ejectPending, true);
});

test('the waiting ejection can be cancelled from the header cross; nothing is ejected afterwards', async () => {
  const { store, calls, device } = await fixture();
  const { gate, handle } = blockingSend(store);
  await tick();
  store.ejectWhenIdle('d');
  store.cancelEjectWait('d');
  assert.equal(device().ejectPending, false);
  gate.resolve(); await handle.finished; await tick();
  assert.deepEqual(calls, []);
  assert.equal(device().state, 'ready');
});

test('closing the app meanwhile: the ejection counts as Lunii activity, so the close guard waits for it too', async () => {
  const ejecting = deferred();
  const { store, device } = await fixture({ eject: () => ejecting.promise });
  const { gate, handle } = blockingSend(store);
  await tick();
  store.ejectWhenIdle('d');
  gate.resolve(); await handle.finished; await tick();
  assert.equal(describeLuniiActivity(store.getSnapshot().luniiDevices, store.queued()).active, true, 'ejecting holds the device');
  ejecting.resolve(); await tick();
  assert.equal(device().state, 'ejected');
  assert.equal(describeLuniiActivity(store.getSnapshot().luniiDevices, store.queued()).active, false);
});

test('header: the eject button is never silently refused; a waiting ejection is said and has its cross', () => {
  const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
  const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : '';
  const render = props => { const app = runner(() => LuniiPanelHeader(props)); try { return app.render(); } finally { app.unmount(); } };
  const base = { ...detail('d'), totalBytes: 1, freeBytes: 1 };
  const ejectOf = tree => elements(tree).find(e => e.type === Button && e.props['aria-label'] === 'Éjecter');
  const tipOf = (tree, element) => elements(tree).find(e => e.type === Tooltip && [].concat(e.props.children).includes(element))?.props.text;
  const busy = render({ device: { ...base, busy: true } });
  assert.equal(ejectOf(busy).props.disabled, false);
  assert.equal(tipOf(busy, ejectOf(busy)), 'Éjecter après les opérations en cours');
  let cancelled = 0;
  const pending = render({ device: { ...base, busy: true, ejectPending: true }, onCancelEject: () => cancelled++ });
  assert.equal(ejectOf(pending).props.disabled, true);
  assert.equal(tipOf(pending, ejectOf(pending)), 'Éjection à la fin des opérations');
  assert.match(text(elements(pending).find(e => e.props?.role === 'status')), /Éjection à la fin des opérations/);
  const cross = elements(pending).find(e => e.type === LuniiQueuedCancel);
  assert.equal(cross.props.label, 'Ne plus éjecter à la fin'); assert.equal(cross.props.describedBy, 'lunii-eject-pending-d');
  cross.props.onCancel(); assert.equal(cancelled, 1);
});
