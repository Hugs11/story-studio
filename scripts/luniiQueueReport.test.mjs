import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { createTestI18n } from './i18nTestSetup.mjs';
import { createLuniiDevices } from '../src/store/catalogue/luniiDevices.js';
import { heldByEngine, queueReports, queuedMarks } from '../src/store/catalogue/luniiQueueView.js';
registerHooks({ resolve(specifier, context, next) {
  // Only the pure activity builder is called; the hook driver does not model this hook.
  if (specifier === 'react' && context.parentURL?.endsWith('/CatalogueActivity.jsx')) return next(new URL('../node_modules/react/index.js', import.meta.url).href, context);
  if (specifier.startsWith('.') && context.parentURL) for (const extension of ['.jsx', '.js']) {
    if (existsSync(new URL(specifier + extension, context.parentURL))) return next(specifier + extension, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { LuniiQueueReport, luniiQueueEntries } = await import('../src/components/Catalogue/activity/LuniiQueueReport.jsx');
const { activityItems, sendKeepsActivityOpen } = await import('../src/components/Catalogue/activity/CatalogueActivity.jsx');
const { LuniiSendBilan, LuniiSendRefusals } = await import('../src/components/Catalogue/activity/LuniiSendItems.jsx');
const { LuniiPanelHeader } = await import('../src/components/Catalogue/lunii/LuniiPanelHeader.jsx');
const { LuniiFiche } = await import('../src/components/Catalogue/lunii/LuniiFiche.jsx');
const { LuniiSelectionPanel } = await import('../src/components/Catalogue/lunii/LuniiSelectionPanel.jsx');
const { storyMenuEntries } = await import('../src/components/Catalogue/lunii/LuniiStoryMenu.jsx');
const { LuniiQueuedCancel } = await import('../src/components/Catalogue/lunii/LuniiQueuedMark.jsx');
const { Button } = await import('../src/components/common/Button.jsx');
const { Tooltip } = await import('../src/components/common/Tooltip.jsx');
const t = createTestI18n().getFixedT('fr');

const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? [LuniiSendBilan, LuniiSendRefusals].includes(node.type) ? text(render(node.type, node.props)) : text(node.props?.children) : '';
const render = (Component, props) => { const app = runner(() => Component(props)); try { return app.render(); } finally { app.unmount(); } };
const tipOf = (tree, element) => elements(tree).find(e => e.type === Tooltip && [].concat(e.props.children).includes(element))?.props.text;
const timers = { setTimeout: (fn, ms) => { if (ms <= 500) queueMicrotask(fn); return null; }, clearTimeout() {} };
const tick = async (n = 8) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(ok => { resolve = ok; }); return { promise, resolve }; };
const detail = id => ({ id, name: 'Chambre', state: 'ready', busy: false, inspected: true, stories: [{ key: 'a', title: 'A' }, { key: 'b', title: 'B' }], orphans: [], banner: [] });
async function fixture(overrides = {}) {
  const calls = [];
  const engine = { busy: false };
  const api = {
    list: async () => [{ id: 'd', busy: engine.busy }],
    inspect: async id => detail(id),
    getOperation: async () => ({ status: 'success' }),
    rename: async (id, name) => { calls.push(['rename', name]); return { device: detail(id) }; },
    remove: async (id, keys) => { calls.push(['remove', keys]); return { device: detail(id) }; },
    ...overrides,
  };
  const store = createLuniiDevices(api, { read() {}, write() {} }, timers, async () => '/w');
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d');
  return { store, api, calls, engine };
}
const entry = (id, run, kind, state, extra = {}) => ({ id, run, kind, keys: [], title: id.toUpperCase(), state, reason: null, deviceName: 'Chambre', ...extra });

test('three queued sends unplugged during X: one complete story, still closed after remount and replug', async () => {
  const gate = deferred();
  const reason = { code: 'STORYTELLER_SEND_DISCONNECTED', params: {} };
  const snapshot = { operationId: 'op', operationKind: 'luniiSend', status: 'failed', result: { stories: [{ exemplarId: 'x', step: 'interrupted', deviceFault: true, reason }] } };
  const { store } = await fixture({ getOperation: () => gate.promise });
  let context;
  const send = store.enqueueSend('d', { title: 'X' }, async (device, queueEntryId) => {
    context = { operationId: 'op', queueEntryId, deviceId: device.id, deviceName: device.name, entries: [{ exemplarId: 'x', title: 'X' }], refused: [] };
    return { receipt: { operationId: 'op' }, context };
  });
  const never = () => assert.fail('waiting sends must not start');
  const second = store.enqueueSend('d', { title: 'Y' }, never);
  const third = store.enqueueSend('d', { title: 'Z' }, never);
  await tick();
  const sends = { contexts: [context], contextFor: () => context };
  const line = ({ key, params }) => t(key, params);
  // Terminal events may arrive before the independent runner publishes its report.
  const pending = activityItems(t, line, { sends, summaries: [snapshot], luniiQueue: { entries: store.getQueueReport() } });
  assert.equal(pending.length, 1, 'the terminal card keeps the pill present until the queue report is published');
  assert.match(pending[0].key, /^send-bilan:/);
  store.reconcile([]); gate.resolve(snapshot);
  await Promise.all([send.finished, second.finished, third.finished]);
  const input = () => ({ sends, summaries: [snapshot],
    errors: [{ error: store.getSnapshot().error, queueEntryId: store.getSnapshot().errorQueueEntryId }],
    luniiQueue: { entries: store.getQueueReport(), reports: queueReports(store.getQueueReport()), onDismiss: store.dismissQueueReport } });
  assert.equal(context.queueEntryId, store.getQueueReport().d[0].id);
  assert.equal(store.getSnapshot().errorQueueEntryId, context.queueEntryId);
  const [card, ...rest] = activityItems(t, line, input());
  assert.deepEqual(rest, []);
  assert.match(card.key, /^queue-report:/);
  const content = text(render(card.detail.type, card.detail.props));
  assert.match(content, /Faites : 0 · échouées : 1 · non lancées : 2/);
  assert.match(content, /débranchée pendant la copie de « X ».*Elle n’est pas abîmée/);
  assert.match(content, /restes de la copie seront proposés à la suppression quand tu rebrancheras/);
  assert.match(content, /Envoi : Y/); assert.match(content, /Envoi : Z/);
  sends.contexts = []; sends.contextFor = () => null;
  const [afterRemount] = activityItems(t, line, input());
  assert.equal(text(render(afterRemount.detail.type, afterRemount.detail.props)), content, 'the queue keeps the full story even after the operation context is retired');
  card.onDismiss();
  assert.deepEqual(activityItems(t, line, input()), []);
  store.reconcile([{ id: 'd', state: 'ready', busy: false }]); await tick();
  assert.deepEqual(activityItems(t, line, input()), [], 'dismissal never reveals the suppressed cards');
});

for (const isolated of [true, false]) test(`real queued multi-story send interrupted: isolated=${isolated}`, async () => {
  const gate = deferred();
  const reason = { code: 'STORYTELLER_SEND_DISCONNECTED', params: {} };
  const snapshot = { operationId: 'op', operationKind: 'luniiSend', status: 'failed', result: { stories: [
    { exemplarId: 'a', step: 'done' }, { exemplarId: 'b', step: 'interrupted', deviceFault: true, reason }, { exemplarId: 'c', step: 'notStarted' },
    { exemplarId: 'dup', step: 'refused', reason: { code: 'STORYTELLER_STORY_DUPLICATE', params: { position: 2 } } },
  ] } };
  const { store } = await fixture({ getOperation: () => gate.promise });
  let context;
  const send = store.enqueueSend('d', { title: 'A, B, C' }, async (device, queueEntryId) => {
    context = { operationId: 'op', deviceId: device.id, deviceName: device.name, queueEntryId, startPosition: 3,
      entries: ['a', 'b', 'c', 'dup'].map(exemplarId => ({ exemplarId, title: exemplarId.toUpperCase() })),
      refused: [{ ficheId: 'official', title: 'OFFICIAL', reason: { code: 'STORYTELLER_OFFICIAL_REFUSED' } }] };
    return { receipt: { operationId: 'op' }, context };
  });
  const next = isolated ? null : store.enqueueSend('d', { title: 'D' }, () => assert.fail('not started'));
  await tick(); store.reconcile([]); gate.resolve(snapshot);
  await Promise.all([send.finished, next?.finished]);
  const input = { sends: { contexts: [context], contextFor: () => context }, summaries: [snapshot],
    errors: [{ error: store.getSnapshot().error, queueEntryId: store.getSnapshot().errorQueueEntryId }],
    luniiQueue: { entries: store.getQueueReport(), reports: queueReports(store.getQueueReport()) } };
  const cards = activityItems(t, ({ key, params }) => t(key, params), input);
  assert.equal(cards.length, 1);
  assert.match(cards[0].key, isolated ? /^send-bilan:/ : /^queue-report:/);
  if (isolated) assert.equal(cards[0].label, 'Envoi interrompu');
  const content = text(render(cards[0].detail.type, cards[0].detail.props));
  assert.match(content, /A.*3/);
  assert.match(content, /débranchée pendant la copie de « B ».*Elle n’est pas abîmée/);
  assert.match(content, /C.*pas.*lancée|pas.*lancée.*C/);
  assert.match(content, /OFFICIAL/); assert.match(content, /elle s’installe avec l’application Lunii/);
  assert.match(content, /DUP/); assert.match(content, /Déjà sur la Lunii/);
  assert.match(content, /restes de la copie seront proposés/);
  assert.equal(sendKeepsActivityOpen(isolated ? ['attention:op'] : [], input, ['op']), true);
});

test('waitOperation without a snapshot keeps the send card even with a matching queue entry', async () => {
  const { store } = await fixture({ getOperation: undefined });
  let context;
  const send = store.enqueueSend('d', { title: 'X' }, async (device, queueEntryId) => {
    context = { operationId: 'op', deviceId: device.id, queueEntryId, entries: [{ exemplarId: 'x', title: 'X' }], refused: [] };
    return { receipt: { operationId: 'op' }, context };
  });
  const next = store.mutate('d', 'rename', ['Salon']);
  await Promise.all([send.finished, next]);
  const snapshot = { operationId: 'op', operationKind: 'luniiSend', status: 'failed', result: { stories: [{ exemplarId: 'x', step: 'interrupted', reason: { code: 'STORYTELLER_SEND_DISCONNECTED' } }] } };
  const input = { sends: { contexts: [context], contextFor: () => context }, summaries: [snapshot], luniiQueue: { entries: store.getQueueReport(), reports: queueReports(store.getQueueReport()) } };
  const cards = activityItems(t, ({ key, params }) => t(key, params), input);
  assert.equal(cards.length, 1); assert.match(cards[0].key, /^send-bilan:/);
  assert.equal(sendKeepsActivityOpen(['attention:op'], input, ['op']), true);
});

test('a successful send still closes the activity with an older report from another Lunii', () => {
  const context = { operationId: 'new', deviceId: 'd', queueEntryId: 'new-entry' };
  const input = { summaries: [{ operationId: 'new', operationKind: 'luniiSend', status: 'success' }], sends: { contextFor: () => context },
    luniiQueue: { reports: [{ deviceId: 'old-device', run: 'old-run', failed: [entry('old', 'old-run', 'send', 'failed')] }] } };
  assert.equal(sendKeepsActivityOpen([], input, ['new']), false);
});

test('repatriations and full-device faults keep their activity entries', () => {
  const line = ({ key, params }) => t(key, params);
  for (const [kind, code, step, queued, expected] of [
    ['luniiRepatriate', 'STORYTELLER_REPATRIATE_DISCONNECTED', 'interrupted', false, ['error:', 'summary:', 'queue-report:']],
    ['luniiRepatriate', 'STORYTELLER_REPATRIATE_DISCONNECTED', 'interrupted', true, ['error:', 'summary:', 'queue-report:']],
    ['luniiSend', 'STORYTELLER_NO_SPACE', 'refused', true, ['error:', 'send-bilan:', 'queue-report:']],
  ]) {
    const reason = { code, params: { missingBytes: 42 }, deviceFault: true };
    const context = { operationId: 'op', deviceId: 'd', ...(queued ? { queueEntryId: 'e' } : {}), entries: [{ exemplarId: 'x', title: 'X' }], refused: [] };
    const snapshot = { operationId: 'op', operationKind: kind, status: 'failed', result: { stories: [{ exemplarId: 'x', step, reason }] } };
    const report = { deviceId: 'd', run: 'r', done: 0, failed: [entry('e', 'r', kind === 'luniiSend' ? 'send' : 'repatriate', 'failed', { reason })], notStarted: [], excluded: [] };
    const items = activityItems(t, line, { sends: { contexts: [context], contextFor: () => context }, errors: [{ error: reason }], summaries: [snapshot], luniiQueue: { reports: [report] } });
    assert.deepEqual(items.map(item => expected.find(prefix => item.key.startsWith(prefix))), expected, `${kind}: ${code}, queued=${queued}`);
    assert.doesNotMatch(text(render(LuniiQueueReport, { report })), /Elle n’est pas abîmée|restes de la copie/);
  }
});

for (const kind of ['send', 'repatriate']) test(`${kind}: other terminal faults keep the original error and report without merging`, async () => {
  const reason = { code: kind === 'send' ? 'STORYTELLER_NO_SPACE' : 'STORYTELLER_REPATRIATE_DISCONNECTED', params: {}, deviceFault: true };
  const snapshot = { status: 'failed', result: { stories: [{ exemplarId: 'x', step: kind === 'send' ? 'refused' : 'interrupted', reason, deviceFault: true }] } };
  const { store } = await fixture({ getOperation: async () => snapshot, repatriate: async () => ({ operationId: 'op' }) });
  if (kind === 'send') await store.enqueueSend('d', { title: 'X' }, async (device, queueEntryId) => ({ receipt: { operationId: 'op' }, context: { deviceId: device.id, queueEntryId, entries: [{ exemplarId: 'x', title: 'X' }], refused: [] } })).finished;
  else await store.mutate('d', 'repatriateMany', [], ['a']);
  assert.equal(store.getSnapshot().error.code, reason.code);
  assert.equal(store.getSnapshot().errorQueueEntryId, null);
  const [report] = queueReports(store.getQueueReport());
  assert.equal(report.failed[0].reason.code, reason.code);
  assert.equal(report.failed[0].sendInterruption, undefined);
});

test('a report per finished run that did not do everything; a clean, running or closed run has none', () => {
  const queues = { d: [
    entry('a', 'clean', 'rename', 'done'), entry('b', 'clean', 'remove', 'cancelled'),
    entry('c', 'live', 'rename', 'failed'), entry('d', 'live', 'remove', 'queued'),
    entry('e', 'closed', 'rename', 'failed', { reported: true }),
    entry('f', 'stopped', 'send', 'done'), entry('g', 'stopped', 'rename', 'failed', { reason: { code: 'STORYTELLER_WRITE_FAILED' } }), entry('h', 'stopped', 'remove', 'notStarted', { reason: { code: 'STORYTELLER_DEVICE_GONE', deviceFault: true } }),
  ] };
  const reports = queueReports(queues);
  assert.deepEqual(reports.map(r => [r.run, r.done, r.failed.map(e => e.id), r.notStarted.map(e => e.id), r.stop?.code, r.deviceName]), [['stopped', 1, ['g'], ['h'], 'STORYTELLER_DEVICE_GONE', 'Chambre']]);
});

test('unplugged during the queue: waiting entries are not started, reported with the reason, and nothing restarts on replug', async () => {
  const { store, calls } = await fixture();
  const gate = deferred();
  const send = store.enqueueSend('d', { title: 'Long' }, async () => { await gate.promise; throw { code: 'STORYTELLER_SEND_DISCONNECTED', params: {}, deviceFault: true }; }, () => {}, () => null);
  const rename = store.mutate('d', 'rename', ['Salon']);
  await tick();
  store.reconcile([]);
  gate.resolve(); await Promise.all([send.finished, rename]); await tick();
  const [report] = queueReports(store.getQueueReport());
  assert.deepEqual(report.notStarted.map(e => e.kind), ['rename']);
  assert.equal(report.stop.code, 'STORYTELLER_DEVICE_GONE');
  store.reconcile([{ id: 'd', state: 'ready', busy: false }]); await tick();
  assert.deepEqual(calls.filter(call => call[0] === 'rename'), [], 'nothing restarts on its own');
});

test('(a) a queued send that fails before any copy no longer vanishes: it is in the report with its reason', async () => {
  const { store } = await fixture();
  await store.enqueueSend('d', { title: 'Conte' }, async () => { throw { code: 'STORYTELLER_PROJECT_INCOMPLETE', params: {} }; }, () => {}, () => null).finished;
  const [report] = queueReports(store.getQueueReport());
  assert.deepEqual(report.failed.map(e => [e.kind, e.title]), [['send', 'Conte']]);
  const tree = render(LuniiQueueReport, { report });
  assert.match(text(tree), /Envoi : Conte/);
  assert.match(text(tree), /Faites : 0 · échouées : 1 · non lancées : 0/);
});

test('a removal cancelled because its repatriation failed is explained, with the story title', async () => {
  const { store, calls } = await fixture({ repatriate: async () => { throw { code: 'STORYTELLER_STORY_INCOMPLETE', params: {} }; } });
  const gate = deferred();
  const hold = store.enqueueSend('d', { title: 'Avant' }, async () => { await gate.promise; return {}; }, () => {}, () => null);
  const repatriation = store.mutate('d', 'repatriateMany', [], ['a']);
  const removal = store.mutate('d', 'remove', [['a']], ['a']);
  gate.resolve(); await Promise.all([hold.finished, repatriation, removal]); await tick();
  assert.deepEqual(calls.filter(call => call[0] === 'remove'), [], 'the story stays on the Lunii');
  const [report] = queueReports(store.getQueueReport());
  assert.deepEqual(report.excluded, [{ key: 'a', title: 'A' }]);
  assert.match(text(render(LuniiQueueReport, { report })), /Retrait annulé pour A : son rapatriement a échoué, l’histoire reste sur la Lunii/);
});

test('the report says why the queue stopped: unplugged, or a fault of the Lunii', () => {
  const base = { deviceId: 'd', run: 'r', deviceName: 'Chambre', done: 2, failed: [], excluded: [] };
  const gone = render(LuniiQueueReport, { report: { ...base, notStarted: [entry('x', 'r', 'remove', 'notStarted')], stop: { code: 'STORYTELLER_DEVICE_GONE' } } });
  assert.match(text(gone), /La Lunii a été débranchée : ces opérations n’ont pas été lancées et ne repartiront pas seules/);
  assert.match(text(gone), /Retrait : X/);
  const fault = render(LuniiQueueReport, { report: { ...base, notStarted: [entry('y', 'r', 'rename', 'notStarted')], stop: { code: 'STORYTELLER_DEVICE_UNRESPONSIVE', deviceFault: true } } });
  assert.match(text(fault), /La file s’est arrêtée : La Lunii a cessé de répondre\..*ne repartiront pas seules/);
  for (const tree of [gone, fault]) assert.ok(elements(tree).some(e => e.type === 'ul' && e.props['aria-label'] === 'Opérations non lancées'), 'named list for screen readers');
});

test('one activity entry per report, an issue named after the Lunii; its cross closes it for the session', async () => {
  const { store } = await fixture();
  await store.enqueueSend('d', { title: 'Conte' }, async () => { throw { code: 'STORYTELLER_PROJECT_INCOMPLETE', params: {} }; }, () => {}, () => null).finished;
  const reports = queueReports(store.getQueueReport());
  const [item] = luniiQueueEntries(t, { luniiQueue: { reports, onDismiss: store.dismissQueueReport } });
  assert.equal(item.tone, 'issue'); assert.equal(item.kind, 'summary');
  assert.equal(item.label, 'File de « Chambre » : tout n’a pas été fait');
  item.onDismiss();
  assert.deepEqual(queueReports(store.getQueueReport()), []);
  assert.deepEqual(luniiQueueEntries(t, {}), []);
});

test('a stopped Lunii still held by the engine is not sent to the eject button: unplug it; once freed, the usual advice', async () => {
  const { presentCatalogueError } = await import('../src/store/catalogue/catalogueApi.js');
  const fault = { code: 'STORYTELLER_DEVICE_UNRESPONSIVE', params: {}, deviceFault: true };
  const { store, engine } = await fixture({ rename: async () => { throw fault; } });
  engine.busy = true;
  await store.mutate('d', 'rename', ['Salon']); await tick();
  assert.equal(store.getSnapshot().error.held, true);
  // Same choice as the activity entry of the error (CatalogueActivity).
  const label = () => heldByEngine(store.getSnapshot().error) ? t('catalogue:lunii.unresponsiveHeld') : presentCatalogueError(store.getSnapshot().error).message;
  assert.equal(label(), 'La Lunii a cessé de répondre et reste occupée : l’éjection ne peut pas aboutir. Débranche-la puis rebranche-la.');
  engine.busy = false;
  store.reconcile([{ id: 'd', state: 'ready', busy: false }]); await tick();
  assert.equal(store.getSnapshot().error.held, false);
  assert.equal(label(), 'La Lunii a cessé de répondre. Éjecte-la, débranche-la puis rebranche-la.');
});

test('the panel header says that a report waits in the activity (screen readers included)', () => {
  const tree = render(LuniiPanelHeader, { device: { ...detail('d'), totalBytes: 1, freeBytes: 1 }, queue: { count: 0, marks: [], report: true } });
  assert.match(text(elements(tree).find(e => e.props?.role === 'status')), /File terminée : tout n’a pas été fait. Le bilan est dans « à voir », en haut à droite./);
});

test('(b) inspector menu: a story whose removal waits offers no contradicting gesture without saying why', () => {
  const device = detail('d');
  const story = { key: 'a', title: 'A', kind: 'unknown' };
  const entries = storyMenuEntries({ device, story, gestures: {}, onName() {}, t, queued: [{ entryId: 'r', action: 'remove' }] });
  for (const item of entries) {
    assert.equal(item.enabled, false, item.key);
    assert.match(item.title ?? item.detail, /Retrait en attente : annule-le d’abord/, item.key);
  }
  assert.ok(storyMenuEntries({ device, story, gestures: {}, onName() {}, t }).every(item => item.enabled));
});

test('(b) inspector fiche: the waiting gesture is shown with its cross; Delete does not queue a second removal', () => {
  const device = detail('d');
  const story = { key: 'a', title: 'A', kind: 'creation', position: 1 };
  const calls = [];
  let cancelled = null;
  const queued = queuedMarks([{ id: 'r', kind: 'remove', keys: ['a'], state: 'queued', args: [['a']] }]);
  const tree = render(LuniiFiche, { device, story, rows: [story], gestures: { remove: (...args) => calls.push(args) }, queued, onCancelQueued: id => { cancelled = id; }, onNavigate() {}, onClose() {} });
  assert.match(text(tree), /Retrait en attente/);
  const cross = elements(tree).find(e => e.type === LuniiQueuedCancel);
  cross.props.onCancel(); assert.equal(cancelled, 'r');
  const remove = elements(tree).find(e => e.type === Button && e.props.className === 'lunii-remove');
  assert.equal(remove.props.disabled, true); assert.match(tipOf(tree, remove), /Retrait en attente/);
  tree.props.onKeyDown({ key: 'Delete', target: { closest: () => null }, preventDefault() {} });
  assert.deepEqual(calls, []);
});

test('(b) selection panel: stories already waiting for removal are left out of every gesture, and it says so', () => {
  const device = detail('d');
  const stories = [{ key: 'a', title: 'A', kind: 'creation' }, { key: 'b', title: 'B', kind: 'creation' }];
  const calls = [];
  const queued = queuedMarks([{ id: 'r', kind: 'remove', keys: ['a'], state: 'queued', args: [['a']] }]);
  const tree = render(LuniiSelectionPanel, { device, stories, gestures: { remove: (...args) => calls.push(args) }, queued, onClose() {} });
  assert.match(text(tree), /Une histoire de la sélection attend déjà son retrait : elle est laissée de côté/);
  elements(tree).find(e => e.type === Button && e.props.className === 'lunii-remove').props.onClick();
  assert.deepEqual(calls[0][1].map(s => s.key), ['b']);
  const all = render(LuniiSelectionPanel, { device, stories: [stories[0]], gestures: {}, queued, onClose() {} });
  const remove = elements(all).find(e => e.type === Button && e.props.className === 'lunii-remove');
  assert.equal(remove.props.disabled, true); assert.match(tipOf(all, remove), /Retrait en attente/);
});
