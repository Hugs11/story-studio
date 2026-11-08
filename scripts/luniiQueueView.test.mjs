import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { createLuniiDevices } from '../src/store/catalogue/luniiDevices.js';
import { createLuniiGestures } from '../src/store/catalogue/luniiGestures.js';
import { mergeSendingRows } from '../src/store/catalogue/luniiSend.js';
import { queuedCount, queuedDeviceMarks, queuedMarks, queuedOrder, queuedSendRows, removalPending, withQueuedOrder } from '../src/store/catalogue/luniiQueueView.js';
registerHooks({ resolve(specifier, context, next) { return next(specifier.endsWith('/panelResize') ? specifier + '.js' : specifier, context); }, load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { LuniiPanel } = await import('../src/components/Catalogue/lunii/LuniiPanel.jsx');
const { LuniiPanelHeader } = await import('../src/components/Catalogue/lunii/LuniiPanelHeader.jsx');
const { LuniiStoryRow } = await import('../src/components/Catalogue/lunii/LuniiStoryRow.jsx');
const { LuniiQueuedRow } = await import('../src/components/Catalogue/lunii/LuniiQueuedRow.jsx');
const { LuniiQueuedCancel } = await import('../src/components/Catalogue/lunii/LuniiQueuedMark.jsx');
const { LuniiGrip } = await import('../src/components/Catalogue/lunii/LuniiGrip.jsx');
const { Button } = await import('../src/components/common/Button.jsx');
const { Tooltip } = await import('../src/components/common/Tooltip.jsx');

const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : '';
const render = (Component, props) => { const app = runner(() => Component(props)); try { return app.render(); } finally { app.unmount(); } };
const tipOf = (tree, element) => elements(tree).find(e => e.type === Tooltip && [].concat(e.props.children).includes(element))?.props.text;
const stories = [{ key: 'a', title: 'A' }, { key: 'h', title: 'H', hidden: true }, { key: 'b', title: 'B' }, { key: 'c', title: 'C' }];
const device = { id: 'd', state: 'ready', busy: true, queueActive: true, stories, orphans: [], banner: [], totalBytes: 1000, freeBytes: 400 };
const item = (id, title) => ({ exemplarId: id, ficheId: `f-${id}`, title, coverSignature: null });
const send = (id, state, extra) => ({ id, kind: 'send', keys: [], title: '', state, reason: null, items: [item(`${id}1`, `${id} un`), item(`${id}2`, `${id} deux`)], ...extra });
// The waiting bounds of the Lunii never fire here: these tests block an entry on purpose.
const idleTimers = { setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {} };
const entry = (id, kind, keys, args, state = 'queued') => ({ id, kind, keys, title: '', state, reason: null, args });

test('a waiting send shows its stories greyed at the drop place, without numbers, the neighbour first', () => {
  const rows = queuedSendRows(device, [send('s', 'queued', { rowKey: 'b', dropIndex: 2 })]);
  assert.deepEqual(rows.map(r => [r.title, r.index, r.position, r.entryId, r.starting]), [['s un', 2, null, 's', false], ['s deux', 2, null, 's', false]]);
  // The neighbour was removed meanwhile: the remembered index, bounded; dropped at the end: the end.
  assert.equal(queuedSendRows({ ...device, stories: stories.slice(0, 2) }, [send('s', 'queued', { rowKey: 'b', dropIndex: 3 })])[0].index, 2);
  assert.equal(queuedSendRows(device, [send('s', 'queued', { rowKey: null, dropIndex: 1 })])[0].index, 4);
  const merged = mergeSendingRows(stories.map((s, i) => ({ ...s, position: s.hidden ? null : [1, null, 2, 3][i] })), rows);
  assert.deepEqual(merged.map(r => [r.key, r.position]), [['a', 1], ['h', null], ['queued:s:s1', null], ['queued:s:s2', null], ['b', 2], ['c', 3]], 'nothing on the Lunii yet: no number, no shift');
});

test('a started send keeps its rows until its copy is tracked; finished or cancelled sends leave the list', () => {
  assert.deepEqual(queuedSendRows(device, [send('s', 'running', { rowKey: null })]).map(r => r.starting), [true, true]);
  assert.deepEqual(queuedSendRows(device, [send('s', 'running', { rowKey: null })], true), []);
  for (const state of ['done', 'failed', 'cancelled', 'notStarted']) assert.deepEqual(queuedSendRows(device, [send('s', state)]), [], state);
});

test('waiting moves are shown at once and resolved like their execution; a running or finished one is not replayed', () => {
  const moved = queuedOrder(device, [entry('m', 'reorder', ['c'], [{ rowKey: 'a', index: 0 }]), entry('n', 'reorder', ['a'], [{ delta: 1 }])]);
  assert.deepEqual(moved.stories.map(s => s.key), ['c', 'h', 'a', 'b']);
  assert.deepEqual(queuedOrder(device, [entry('m', 'reorder', ['c'], [{ rowKey: 'gone', index: 1 }])]).stories.map(s => s.key), ['a', 'c', 'h', 'b'], 'neighbour gone: nearest index');
  for (const state of ['running', 'done', 'failed', 'cancelled']) assert.equal(queuedOrder(device, [entry('m', 'reorder', ['c'], [{ rowKey: 'a', index: 0 }], state)]), device, state);
  assert.equal(queuedOrder(device, []), device);
  assert.deepEqual(withQueuedOrder([device, { ...device, id: 'e' }], { e: [entry('m', 'reorder', ['a'], [{ rowKey: null, index: 4 }])] }).map(d => d.stories[3].key), ['c', 'a']);
});

test('waiting gestures are named on their rows; removals are struck; device gestures go to the header', () => {
  const waiting = [
    entry('r', 'remove', ['a', 'b'], [['a', 'b']]), entry('o', 'orphan', ['parked:X'], [{ restore: false }]), entry('p', 'orphan', ['Y'], [{ restore: true }]),
    entry('h', 'hide', ['c'], ['c', true]), entry('s', 'hide', ['h'], ['h', false]), entry('n', 'nameStory', ['c'], ['c', 'Titre']), entry('m', 'reorder', ['c'], [{ delta: -1 }]),
    entry('g', 'repatriate', ['b'], ['b', undefined]), entry('q', 'restoreOrphans', ['Z'], [[]]), entry('done', 'remove', ['c'], [['c']], 'done'),
    entry('rn', 'rename', [], ['Chambre']), entry('rp', 'repair', [], []), entry('rs', 'restore', [], []),
  ];
  const marks = queuedMarks(waiting);
  assert.deepEqual(Object.fromEntries([...marks].map(([key, list]) => [key, list.map(m => m.action)])), {
    a: ['remove'], b: ['remove', 'repatriate'], 'parked:X': ['delete'], Y: ['putBack'], c: ['hide', 'name', 'move'], h: ['show'], Z: ['putBack'],
  });
  assert.equal(removalPending(marks.get('b')), true); assert.equal(removalPending(marks.get('parked:X')), true); assert.equal(removalPending(marks.get('c')), false); assert.equal(removalPending(undefined), false);
  assert.deepEqual(queuedDeviceMarks(waiting), [{ entryId: 'rn', action: 'rename', name: 'Chambre' }, { entryId: 'rp', action: 'repair', name: null }, { entryId: 'rs', action: 'restore', name: null }]);
  assert.equal(queuedCount(waiting), waiting.length - 1);
});

test('the store publishes what the list needs of a waiting entry, and its cross cancels it', async () => {
  const pending = new Promise(() => {});
  const api = { list: async () => [{ id: 'd', busy: false }], inspect: async () => ({ ...device, busy: false, queueActive: false }), hide: async () => pending, getOperation: async () => ({ status: 'success' }) };
  const store = createLuniiDevices(api, { read() {}, write() {} }, idleTimers, async () => '/w');
  store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
  void store.mutate('d', 'hide', ['a', true], ['a']);
  const queued = store.enqueueSend('d', { keys: ['x'], items: [item('x', 'X')], title: 'X', dropIndex: 2, rowKey: 'b' }, async () => ({}), () => {}, () => null);
  const [hide, waiting] = store.getSnapshot().luniiQueue.d;
  assert.deepEqual(hide.args, ['a', true]);
  assert.deepEqual([waiting.state, waiting.rowKey, waiting.dropIndex, waiting.items], ['queued', 'b', 2, [item('x', 'X')]]);
  assert.equal(store.cancel(waiting.id), true);
  assert.equal(await queued.finished, null);
  assert.equal(store.getSnapshot().luniiQueue.d[1].state, 'cancelled');
});

test('panel: waiting send rows at their place with their cross, marks on rows, waiting count in the header', () => {
  const cancelled = [];
  const luniiQueue = { d: [send('s', 'queued', { rowKey: 'b' }), entry('r', 'remove', ['a'], [['a']]), entry('rn', 'rename', [], ['Chambre']), entry('old', 'remove', ['c'], [['c']], 'done')] };
  const lunii = { luniiDevices: [device], activeLuniiId: 'd', luniiQueue, selection: { side: 'lunii', ids: [] }, store: { cancel: id => cancelled.push(id) } };
  const tree = render(LuniiPanel, { lunii, onSelect() {} });
  const rows = elements(tree).filter(e => e.type === LuniiStoryRow || e.type === LuniiQueuedRow);
  assert.deepEqual(rows.map(r => [r.type === LuniiQueuedRow ? 'queued' : 'row', r.props.story.key]), [['row', 'a'], ['row', 'h'], ['queued', 'queued:s:s1'], ['queued', 'queued:s:s2'], ['row', 'b'], ['row', 'c']]);
  assert.deepEqual(rows[0].props.queued.map(m => m.action), ['remove']);
  assert.equal(rows[5].props.queued, undefined, 'a finished gesture leaves no mark');
  rows[2].props.onCancel('s'); rows[0].props.onCancelQueued('r');
  const header = elements(tree).find(e => e.type === LuniiPanelHeader);
  assert.equal(header.props.queue.count, 3);
  assert.deepEqual(header.props.queue.marks, [{ entryId: 'rn', action: 'rename', name: 'Chambre' }]);
  header.props.queue.onCancel('rn');
  assert.deepEqual(cancelled, ['s', 'r', 'rn']);
});

test('queued send row: greyed « En attente », its cross cancels the whole send; no cross once started', () => {
  let cancelled = null;
  const [row] = queuedSendRows(device, [send('s', 'queued', { rowKey: null })]);
  const tree = render(LuniiQueuedRow, { story: row, onCancel: id => { cancelled = id; } });
  assert.match(tree.props.className, /is-queued/);
  assert.match(text(tree), /s un.*En attente/);
  const cross = elements(tree).find(e => e.type === LuniiQueuedCancel);
  assert.equal(cross.props.label, 'Annuler l’envoi en attente (2 histoires, dont « s un »)');
  cross.props.onCancel(); assert.equal(cancelled, 's');
  const started = render(LuniiQueuedRow, { story: { ...row, starting: true } });
  assert.equal(elements(started).some(e => e.type === LuniiQueuedCancel), false);
  assert.match(text(started), /préparation des fichiers/);
});

test('a story waiting for removal is struck, its other actions say why they wait, the cross is an app button with an app tooltip', () => {
  let cancelled = null;
  const story = { key: 'a', title: 'A', position: 1 };
  const tree = render(LuniiStoryRow, { story, device, queued: [{ entryId: 'r', action: 'remove' }], onCancelQueued: id => { cancelled = id; } });
  assert.match(tree.props.className, /is-removing/);
  assert.match(text(tree), /Retrait en attente/);
  const grip = elements(tree).find(e => e.type === LuniiGrip);
  assert.match(grip.props.disabledReason, /annule-le d’abord/);
  for (const button of elements(tree).filter(e => e.type === Button && ['Masquer', 'Retirer de la Lunii…'].includes(e.props['aria-label']))) assert.equal(button.props.disabled, true);
  const cross = elements(tree).find(e => e.type === LuniiQueuedCancel);
  assert.equal(cross.props.label, 'Annuler le geste en attente sur « A »');
  assert.equal(cross.props.describedBy, 'lunii-queued-r-a');
  assert.ok(elements(tree).some(e => e.props?.id === 'lunii-queued-r-a'), 'the cross is described by the visible mark');
  cross.props.onCancel(); assert.equal(cancelled, 'r');
  const button = render(LuniiQueuedCancel, { label: 'Annuler', onCancel() {} });
  assert.equal(button.type, Tooltip); assert.equal(button.props.text, 'Annuler');
  assert.equal(elements(button).find(e => e.type === Button).props.title, undefined);
  // A gesture other than removal leaves the row's actions alone.
  const hidden = render(LuniiStoryRow, { story, device, queued: [{ entryId: 'h', action: 'hide' }] });
  assert.doesNotMatch(hidden.props.className, /is-removing/);
  assert.match(text(hidden), /Masquage en attente/);
  const eye = elements(hidden).find(e => e.type === Button && e.props['aria-label'] === 'Masquer');
  assert.equal(eye.props.disabled, false); assert.doesNotMatch(tipOf(hidden, eye), /attente/);
});

test('header: a status region always present says how many operations wait; device gestures have their cross', () => {
  let cancelled = null;
  const empty = render(LuniiPanelHeader, { device });
  const region = elements(empty).find(e => e.props?.role === 'status');
  assert.ok(region, 'present before anything waits'); assert.equal(text(region).trim(), '');
  const tree = render(LuniiPanelHeader, { device, queue: { count: 2, marks: [{ entryId: 'rn', action: 'rename', name: 'Chambre' }], onCancel: id => { cancelled = id; } } });
  assert.equal(text(elements(tree).find(e => e.props?.role === 'status')).trim(), '2 opérations en attente');
  assert.match(text(tree), /Nouveau nom en attente : « Chambre »/);
  elements(tree).find(e => e.type === LuniiQueuedCancel).props.onCancel();
  assert.equal(cancelled, 'rn');
});

test('Delete leaves out the stories whose removal already waits', () => {
  const calls = [];
  const lunii = { luniiDevices: [device], activeLuniiId: 'd', luniiQueue: { d: [entry('r', 'remove', ['a'], [['a']])] }, selection: { side: 'lunii', ids: ['a', 'b'] }, store: {}, gestures: { remove: (...args) => calls.push(args) } };
  const tree = render(LuniiPanel, { lunii, onSelect() {} });
  tree.props.onKeyDown({ key: 'Delete', target: { closest() { return false; } }, preventDefault() {} });
  assert.deepEqual(calls[0][1].map(s => s.key), ['b']);
});

test('a move behind other operations is announced at once, with the place the list already shows', async () => {
  const said = [];
  let finish;
  const lunii = { store: { mutate: () => new Promise(resolve => { finish = resolve; }) } };
  const gestures = createLuniiGestures(lunii, (key, params) => `${key} ${params?.position ?? ''}/${params?.total ?? ''}`, async () => true, text => said.push(text));
  const moving = gestures.move(device, ['c'], -1);
  assert.deepEqual(said, ['catalogue:lunii.movedQueued 2/3']);
  finish({}); await moving;
  assert.deepEqual(said, ['catalogue:lunii.movedQueued 2/3'], 'not announced a second time when it lands');
  const idle = createLuniiGestures({ store: { mutate: async () => ({}) } }, (key, params) => `${key} ${params?.position ?? ''}`, async () => true, text => said.push(text));
  await idle.move({ ...device, queueActive: false }, ['c'], -1);
  assert.equal(said.at(-1), 'catalogue:lunii.moved 2');
});

test('L3b: « Réparer » is refused, with its reason in the app tooltip, while a repair waits or runs', async () => {
  const { LuniiBanner } = await import('../src/components/Catalogue/lunii/LuniiBanner.jsx');
  const { repairPending } = await import('../src/store/catalogue/luniiQueueView.js');
  for (const [state, waiting] of [['queued', true], ['running', true], ['done', false], ['failed', false], ['cancelled', false]]) assert.equal(repairPending([entry('rp', 'repair', [], [], state)]), waiting, state);
  const damaged = { ...device, state: 'damaged', repairPreview: { kept: 1, removed: [] } };
  const free = render(LuniiBanner, { kind: 'damaged', device: damaged });
  assert.equal(elements(free).find(e => e.type === Button).props.disabled, false);
  const tree = render(LuniiBanner, { kind: 'damaged', device: damaged, repairWaiting: true });
  const button = elements(tree).find(e => e.type === Button);
  assert.equal(button.props.disabled, true);
  assert.equal(tipOf(tree, button), 'Une réparation de la liste est déjà en attente ou en cours sur cette Lunii.');
  assert.equal(button.props.title, undefined);
  const lunii = { luniiDevices: [{ ...damaged, banner: ['damaged'] }], activeLuniiId: 'd', luniiQueue: { d: [entry('rp', 'repair', [], [], 'running')] }, selection: { side: 'lunii', ids: [] }, store: {} };
  assert.equal(elements(render(LuniiPanel, { lunii, onSelect() {} })).find(e => e.type === LuniiBanner).props.repairWaiting, true);
});

test('L3b: a mixed removal behind another operation is struck at once, in its execution order', async () => {
  const blocked = new Promise(() => {});
  const orphan = { key: 'parked:ABCDEF00', title: 'Perle', orphan: true, sizeBytes: 1 };
  const real = { ...device, busy: false, queueActive: false, orphans: [orphan] };
  const api = { list: async () => [{ id: 'd', busy: false }], inspect: async () => real, hide: async () => blocked, getOperation: async () => ({ status: 'success' }) };
  const store = createLuniiDevices(api, { read() {}, write() {} }, idleTimers, async () => '/w');
  store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
  void store.mutate('d', 'hide', ['c', true], ['c']);
  const gestures = createLuniiGestures({ store }, key => key, async () => true, () => {});
  void gestures.remove(store.getSnapshot().luniiDevices[0], [stories[0], stories[2], orphan], true);
  await new Promise(resolve => setImmediate(resolve));
  const waiting = store.getSnapshot().luniiQueue.d;
  assert.deepEqual(waiting.map(e => [e.kind, e.state, e.keys]), [['hide', 'running', ['c']], ['remove', 'queued', ['a', 'b']], ['orphan', 'queued', [orphan.key]]]);
  const marks = queuedMarks(waiting);
  for (const key of ['a', 'b', orphan.key]) assert.equal(removalPending(marks.get(key)), true, key);
});

test('L3b: the folded panel shows and announces how many operations wait on each Lunii', () => {
  const second = { ...device, id: 'e', name: 'Salon' };
  const luniiQueue = { d: [send('s', 'queued'), entry('r', 'remove', ['a'], [['a']]), entry('old', 'remove', ['b'], [['b']], 'done')], e: [] };
  const lunii = { luniiDevices: [{ ...device, name: 'Chambre' }, second], activeLuniiId: 'd', luniiPanelCollapsed: true, luniiQueue, selection: { side: 'lunii', ids: [] }, store: {} };
  const tree = render(LuniiPanel, { lunii, onSelect() {}, onDeviceChange() {} });
  const buttons = elements(tree).filter(e => e.type === Button && e.props['data-lunii-drop'] === 'collapsed');
  assert.deepEqual(buttons.map(b => b.props['aria-label']), ['Chambre, 2 opérations en attente', 'Salon']);
  assert.deepEqual(buttons.map(b => elements(b).some(e => e.props?.className === 'lunii-collapsed-queue')), [true, false]);
  assert.equal(text(elements(buttons[0]).find(e => e.props?.className === 'lunii-collapsed-queue')), '2');
  assert.equal(tipOf(tree, buttons[0]), 'Chambre, 2 opérations en attente');
  assert.equal(text(elements(tree).find(e => e.props?.role === 'status')).trim(), '2 opérations en attente');
  const idle = render(LuniiPanel, { lunii: { ...lunii, luniiQueue: {} }, onSelect() {}, onDeviceChange() {} });
  assert.equal(text(elements(idle).find(e => e.props?.role === 'status')).trim(), '', 'present and empty while nothing waits');
});
