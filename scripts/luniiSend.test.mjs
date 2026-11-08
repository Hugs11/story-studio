import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'rolldown/experimental';
import { runner } from './reactHookDriver.mjs';
import { createLuniiDevices } from '../src/store/catalogue/luniiDevices.js';
import {
  buildSelection, sendChoiceAvailability, needsSendChoice, resolveSendChoices, sendableExemplars, dropGauge, dropIndex, estimateBytes, mergeSendingRows, presenceOn, refusalPresentation, screenPosition, sendAttention, sendBilanKind,
  sendButtonState, sendContext, sendOpenKeys, sendPositions, sendProgress, sendReport, sendRefusal, virtualRows,
} from '../src/store/catalogue/luniiSend.js';
import { luniiRows } from '../src/store/catalogue/luniiDevices.js';
import { choiceItems } from '../src/store/catalogue/exemplarChoice.js';

registerHooks({ resolve(specifier, context, next) { return next(specifier.endsWith('/panelResize') ? specifier + '.js' : specifier, context); }, load(url, context, next) {
  if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
  if (url.endsWith('.jsx')) return { format: 'module', source: `import * as InteractionReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'InteractionReact.createElement', pragmaFrag: 'InteractionReact.Fragment' } }).code, shortCircuit: true };
  return next(url, context);
} });
const { LuniiPanel } = await import('../src/components/Catalogue/lunii/LuniiPanel.jsx');
const { LuniiStoryRow } = await import('../src/components/Catalogue/lunii/LuniiStoryRow.jsx');
const { LuniiSendingRow } = await import('../src/components/Catalogue/lunii/LuniiSendingRow.jsx');
const { LuniiPanelHeader } = await import('../src/components/Catalogue/lunii/LuniiPanelHeader.jsx');
const { LuniiSendButton } = await import('../src/components/Catalogue/lunii/LuniiSendButton.jsx');
const { luniiSendEntries, LuniiSendBilan, LuniiSendRefusals } = await import('../src/components/Catalogue/activity/LuniiSendItems.jsx');
const { CompactExemplar } = await import('../src/components/Catalogue/open/CompactExemplar.jsx');
const { ExemplarChoicePanel } = await import('../src/components/Catalogue/open/ExemplarChoiceDialog.jsx');
const { Button } = await import('../src/components/common/Button.jsx');
const { MenuPopover } = await import('../src/components/layout/MenuPopover.jsx');

// Infobulle de l'app (et non `title` natif) qui enveloppe l'élément donné.
const { Tooltip: AppTooltip } = await import('../src/components/common/Tooltip.jsx');
const tipOf = (tree, element) => elements(tree).find(e => e.type === AppTooltip && [].concat(e.props.children).includes(element))?.props.text;
const elements = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(elements) : [node, ...elements(node.props?.children)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join(' ') : node && typeof node === 'object' ? text(node.props?.children) : '';
const render = (Component, props) => { const app = runner(() => Component(props)); try { return app.render(); } finally { app.unmount(); } };

// a visible, b hidden, c visible: screen numbers 1, -, 2.
const stories = [{ key: 'a', title: 'A', kind: 'creation' }, { key: 'b', title: 'B', kind: 'creation', hidden: true }, { key: 'c', title: 'C', kind: 'creation', catalogueFicheId: 'fc' }];
const device = (extra = {}) => ({ id: 'd', name: 'Lunii d’Armand', state: 'ready', busy: false, stories, orphans: [], banner: [], totalBytes: 1000, freeBytes: 400, ...extra });
const card = (id, extra = {}) => ({ id, displayTitle: id.toUpperCase(), uuids: [], coverSignature: 's', referenceExemplarId: `${id}-x`, exemplars: [{ id: `${id}-x`, available: true, sizeBytes: 100 }], ...extra });

test('insertion index counts hidden stories; screen position and command position differ', () => {
  const d = device();
  assert.equal(dropIndex(d, 'a'), 0);
  assert.equal(dropIndex(d, 'c'), 2);
  assert.equal(dropIndex(d, null), 3, 'header or empty area = end of list');
  assert.equal(dropIndex(d, 'unknown'), 3);
  assert.equal(screenPosition(d, 0), 1);
  assert.equal(screenPosition(d, 2), 2, 'before c: only a is visible ahead');
  assert.equal(screenPosition(d, 3), 3);
  assert.deepEqual(sendPositions(d, 2, 3), [2, 3, 4]);
  assert.deepEqual(sendPositions(d, null, 2), [3, 4]);
});

test('the estimate sums the known sizes; the gauge never exceeds the capacity and flags overflow', () => {
  const estimate = estimateBytes([card('x'), card('y', { exemplars: [{ id: 'y-x', available: true, sizeBytes: null }], referenceExemplarId: 'y-x' })]);
  assert.deepEqual(estimate, { bytes: 100, unknown: 1 });
  const gauge = dropGauge(device(), { bytes: 500, unknown: 0 });
  assert.equal(gauge.remaining, 0); assert.equal(gauge.overflow, true); assert.equal(gauge.usedFraction, .6);
  assert.equal(dropGauge(device(), { bytes: 100, unknown: 0 }).remaining, 300);
});

test('the engine selection targets the reference copy at the current revision; cards without a copy are set aside', () => {
  const { entries, skipped } = buildSelection([card('x'), card('n', { exemplars: [], referenceExemplarId: null })], 7);
  assert.deepEqual(entries.map(e => e.selection), [{ exemplarId: 'x-x', expectedRevision: 7 }]);
  assert.deepEqual(skipped.map(c => c.id), ['n']);
});

test('Send button: absent, ready, present, official, blocked and one entry per Lunii', () => {
  const x = card('x');
  assert.equal(sendButtonState(x, [], null).kind, 'none');
  assert.equal(sendButtonState(x, [device({ state: 'detected' })], 'd').kind, 'none', 'an unmounted Lunii is not a destination');
  assert.equal(sendButtonState(x, [device()], 'd').kind, 'ready');
  const here = sendButtonState(card('fc'), [device()], 'd');
  assert.equal(here.kind, 'present'); assert.equal(here.target.presence.position, 2);
  assert.equal(sendButtonState(card('u', { uuids: ['AAAA'] }), [device({ stories: [...stories, { key: 'aaaa', kind: 'official' }] })], 'd').kind, 'official');
  assert.equal(sendButtonState(card('official', { official: true }), [device()], 'd').kind, 'official');
  for (const [extra, code] of [[{ state: 'readOnly' }, 'STORYTELLER_READ_ONLY'], [{ state: 'damaged' }, 'STORYTELLER_PLAYLIST_DAMAGED'], [{ busy: true }, 'STORYTELLER_DEVICE_BUSY']]) {
    const state = sendButtonState(x, [device(extra)], 'd');
    assert.equal(state.kind, 'blocked'); assert.equal(state.refusal, code);
  }
  const two = sendButtonState(x, [device(), device({ id: 'e', name: 'Salon' })], 'd');
  assert.equal(two.kind, 'choose'); assert.deepEqual(two.targets.map(t => t.device.id), ['d', 'e']);
  assert.equal(presenceOn(device(), card('fc')).key, 'c');
});

test('Send button renders its five states with their wording and handlers', () => {
  const sent = [];
  const x = card('x');
  const show = (state) => render(LuniiSendButton, { state, onSend: id => sent.push(id) });
  assert.equal(show(sendButtonState(x, [], null)), null);
  const ready = elements(show(sendButtonState(x, [device()], 'd'))).find(e => e.type === Button);
  assert.equal(ready.props['aria-label'], 'Envoyer sur Lunii d’Armand');
  ready.props.onClick({ stopPropagation() {}, detail: 1 });
  assert.deepEqual(sent, ['d']);
  const present = elements(show(sendButtonState(card('fc'), [device()], 'd'))).find(e => e.type === Button);
  assert.equal(present.props['aria-disabled'], 'true'); assert.match(present.props['aria-label'], /Déjà sur Lunii d’Armand, en position 2\./);
  const official = elements(show(sendButtonState(card('o', { official: true }), [device()], 'd'))).find(e => e.type === Button);
  assert.equal(official.props['aria-disabled'], 'true'); assert.match(official.props['aria-label'], /Histoire Lunii : elle s’installe/);
  const menu = show(sendButtonState(x, [device(), device({ id: 'e', name: 'Salon' })], 'd'));
  assert.ok(elements(menu).some(e => e.type === MenuPopover), 'two Lunii: a menu, not a direct send');
  assert.equal(sent.length, 1);
  const blocked = elements(show(sendButtonState(x, [device({ state: 'readOnly' })], 'd'))).find(e => e.type === Button);
  assert.equal(blocked.props['aria-disabled'], 'true');
});

const snapshot = (stories, status = 'running') => ({ operationId: 'op', operationKind: 'luniiSend', status, result: { stories } });
function context(cards = ['x', 'y', 'z'], d = device(), index = 2) {
  const picked = cards.map(id => card(id));
  const { entries } = buildSelection(picked, 1);
  return sendContext({ operationId: 'op', device: d, startIndex: index, cards: picked, entries });
}
const item = (id, step, extra = {}) => ({ exemplarId: `${id}-x`, step, progress: step === 'done' ? 100 : 0, reason: null, ...extra });

test('mixed outcome: refusals are listed with reasons and the others land at consecutive positions', () => {
  const ctx = context(['x', 'y', 'z']);
  const duplicate = { code: 'STORYTELLER_STORY_DUPLICATE', params: { position: 5 } };
  const report = sendReport(ctx, snapshot([item('x', 'done'), item('y', 'refused', { reason: duplicate }), item('z', 'done')], 'partial'), [device({ stories: [...stories, { key: 'y-key', catalogueFicheId: 'y' }] })]);
  assert.deepEqual(report.done.map(d => [d.title, d.position]), [['X', 2], ['Z', 3]], 'the refused story takes no slot');
  assert.equal(report.refused.length, 1);
  assert.equal(report.refused[0].presentation.action, 'see');
  assert.equal(report.refused[0].presentation.params.position, 3, 'the device list decides the shown position');
  assert.equal(report.refused[0].seeKey, 'y-key');
  assert.equal(sendBilanKind(report).kind, 'partial', 'a refused story makes the send incomplete');
});

test('refusal reasons map to their line and follow-up', () => {
  const cases = [
    ['STORYTELLER_OFFICIAL_REFUSED', {}, null], ['STORYTELLER_NAVIGATION_REFUSED', {}, 'editor'], ['STORYTELLER_PROJECT_INCOMPLETE', { cause: { code: 'X' } }, 'editor'],
    ['STORYTELLER_NO_SPACE', { missingBytes: 64 }, null], ['STORYTELLER_NO_SPACE_UNKNOWN', {}, null], ['STORYTELLER_STORY_DUPLICATE_UNLISTED', {}, 'see'], ['STORYTELLER_STORY_DUPLICATE', { position: 3 }, 'see'],
  ];
  for (const [code, params, action] of cases) assert.equal(refusalPresentation({ code, params }).action, action, code);
  assert.equal(refusalPresentation({ code: 'STORYTELLER_NO_SPACE', params: { missingBytes: 64 } }).bytes, 64);
  assert.equal(refusalPresentation({ code: 'SOMETHING_ELSE' }).key, null, 'unknown codes fall back to the registry message');
  assert.equal(refusalPresentation({ code: 'STORYTELLER_STORY_DUPLICATE', params: { position: 3 } }).params.position, 3);
  for (const kind of ['IMAGE', 'SOUND']) {
    const named = { code: `STORYTELLER_${kind}_UNREADABLE`, params: { screen: 'La girafe' } };
    assert.deepEqual(refusalPresentation(named), { key: null, params: {}, reason: named, action: 'editor' }, 'the registry sentence names the screen; the editor fixes it');
    const unnamed = { code: `STORYTELLER_${kind}_UNREADABLE_UNNAMED`, params: {} };
    assert.deepEqual(refusalPresentation(unnamed).reason, unnamed);
    assert.equal(refusalPresentation(unnamed).action, 'editor');
    assert.deepEqual(refusalPresentation({ code: named.code, params: {} }).reason, unnamed, 'a screen name filtered out falls back to the sentence without it');
  }
});

test('before i18n initialization, an English host still renders the French catalogue conjunction', () => {
  const original = Intl.ListFormat;
  try {
    Intl.ListFormat = class extends original {
      constructor(locale, options) { super(locale ?? 'en-US', options); }
    };
    const ctx = context(['x', 'y', 'z']);
    const cancelled = { code: 'STORYTELLER_SEND_CANCELLED', params: {} };
    const snap = snapshot([item('x', 'done'), item('y', 'refused', { reason: cancelled }), item('z', 'refused', { reason: cancelled })], 'cancelled');
    const bilan = text(render(LuniiSendBilan, { report: sendReport(ctx, snap) }));
    assert.match(bilan, /Y et Z/);
    assert.doesNotMatch(bilan, /Y and Z/);
  } finally { Intl.ListFormat = original; }
});

test('cancellation settles the rest without refusals; the story in progress is not shown as sent', () => {
  const ctx = context(['x', 'y', 'z']);
  const cancelled = { code: 'STORYTELLER_SEND_CANCELLED', params: {} };
  const snap = snapshot([item('x', 'done'), item('y', 'refused', { reason: cancelled }), item('z', 'refused', { reason: cancelled })], 'cancelled');
  const report = sendReport(ctx, snap);
  assert.equal(report.done.length, 1); assert.equal(report.refused.length, 0); assert.equal(report.cancelled, 2);
  assert.deepEqual(report.notStarted.map(story => story.title), ['Y', 'Z']);
  const bilan = text(render(LuniiSendBilan, { report }));
  assert.match(bilan, /Y et Z/, 'the cancellation names every story that was not sent');
  assert.match(bilan, /« X » envoyée/, 'the success names the story that was sent');
  assert.equal(sendBilanKind(report).kind, 'cancelled');
  assert.deepEqual(virtualRows(ctx, snap).map(r => r.title), ['X'], 'only the copied story keeps a row');
  assert.equal(sendProgress(ctx, snapshot([item('x', 'copying', { progress: 80 })])).current.title, 'X');
});

test('a simulated unplugging is an interruption: nothing is shown as sent for the story in progress', () => {
  const ctx = context(['x', 'y']);
  const cut = { code: 'STORYTELLER_SEND_DISCONNECTED', params: {} };
  const snap = snapshot([item('x', 'interrupted', { reason: cut }), item('y', 'pending')], 'failed');
  const report = sendReport(ctx, snap);
  assert.equal(report.done.length, 0); assert.equal(report.interrupted.title, 'X'); assert.equal(report.cancelled, 1);
  assert.deepEqual(report.notStarted.map(story => story.title), ['Y']);
  assert.match(text(render(LuniiSendBilan, { report })), /Non lancée : « Y »/, 'the pending story is named separately from the interrupted copy');
  assert.deepEqual(sendBilanKind(report), { kind: 'interrupted', tone: 'issue', titleKey: 'catalogue:lunii.sendBilan.interrupted' });
  assert.deepEqual(virtualRows(ctx, snap), [], 'no row for an interrupted story or one that never started');
});

test('the final warning keeps a finished bilan and adds a discreet notice', () => {
  const ctx = context(['x']);
  const report = sendReport(ctx, snapshot([item('x', 'done', { reason: { code: 'STORYTELLER_WRITE_FAILED', params: {} } })], 'success'));
  assert.equal(report.warning, true); assert.equal(report.done.length, 1); assert.equal(sendBilanKind(report).kind, 'done');
});

test('one bilan per send: everything, part or nothing left, with its title, tone and body in order', () => {
  const ctx = context(['x', 'y']);
  const sends = { contextFor: () => ctx, contexts: [ctx], devices: [device()], handlers: { openEditor: id => opened.push(id), see() {} } };
  const opened = [];
  const t = key => key, line = ({ key }) => key;
  const damaged = { code: 'STORYTELLER_IMAGE_UNREADABLE', params: { screen: 'La girafe' } };
  const bilanOf = (stories, status) => {
    const entries = luniiSendEntries(t, line, { sends, running: [], summaries: [snapshot(stories, status)], onDismissSummary() {} });
    assert.equal(entries.length, 1, 'a single entry, no separate refusals');
    return entries[0];
  };
  const all = bilanOf([item('x', 'done'), item('y', 'done')], 'success');
  assert.deepEqual([all.tone, all.label], ['success', 'catalogue:lunii.sendBilan.done']);
  const part = bilanOf([item('x', 'done'), item('y', 'refused', { reason: damaged })], 'partial');
  assert.deepEqual([part.tone, part.label], ['issue', 'catalogue:lunii.sendBilan.partial']);
  const none = bilanOf([item('x', 'refused', { reason: damaged }), item('y', 'failed', { reason: { code: 'STORYTELLER_WRITE_FAILED', params: {} } })], 'partial');
  assert.deepEqual([none.tone, none.label], ['issue', 'catalogue:lunii.sendBilan.failed']);
  assert.equal(sendBilanKind(sendReport(ctx, snapshot([], 'failed'))).kind, 'failed');
  // Body: the positions sentence, then the stories that did not leave, nothing about "To fix".
  const body = render(LuniiSendBilan, part.detail.props);
  const children = elements(body);
  const sent = children.findIndex(e => e.type === 'p');
  const refusals = children.findIndex(e => e.type === LuniiSendRefusals);
  assert.ok(sent >= 0 && refusals > sent, 'positions first, then the refusals');
  assert.doesNotMatch(text(body), /À régler|notSent/);
  const list = render(LuniiSendRefusals, children[refusals].props);
  assert.match(text(list), /Y/);
  const editor = elements(list).find(e => e.type === Button);
  assert.ok(editor, 'the damaged story offers the editor');
  editor.props.onClick();
  assert.deepEqual(opened, ['y']);
  const empty = render(LuniiSendBilan, none.detail.props);
  assert.equal(elements(empty).filter(e => e.type === 'p').length, 0, 'nothing sent: no positions sentence, the list says it all');
});

test('rows being copied sit at their insertion index and shift the numbers behind them', () => {
  const ctx = context(['x', 'y']);
  const rows = mergeSendingRows(luniiRows(device()), virtualRows(ctx, snapshot([item('x', 'copying'), item('y', 'pending')])));
  assert.deepEqual(rows.map(r => r.key), ['a', 'b', 'sending:x-x', 'sending:y-x', 'c']);
  assert.deepEqual(rows.map(r => r.position), [1, null, 2, 3, 4]);
  const end = mergeSendingRows(luniiRows(device({ orphans: [{ key: 'o' }] })), virtualRows(context(['x'], device(), 3), snapshot([item('x', 'done')])));
  assert.deepEqual(end.map(r => r.key), ['a', 'b', 'c', 'sending:x-x', 'o'], 'orphans stay after the list');
  assert.equal(sendRefusal(device({ state: 'readOnly' })), 'STORYTELLER_READ_ONLY');
});

test('the pill opens at the start and again on failure or interruption, never on a plain success', () => {
  const ctx = context(['x']);
  const by = () => ctx;
  assert.deepEqual(sendOpenKeys([snapshot([item('x', 'preparing')])], by), ['start:op']);
  assert.deepEqual(sendOpenKeys([snapshot([item('x', 'done')], 'success')], by), []);
  assert.deepEqual(sendOpenKeys([snapshot([item('x', 'failed')], 'failed')], by), ['attention:op']);
  assert.deepEqual(sendOpenKeys([snapshot([item('x', 'interrupted')], 'failed')], by), ['attention:op']);
  assert.equal(sendAttention(ctx, snapshot([item('x', 'done')], 'partial')), null);
  const two = context(['x', 'y']);
  const refused = item('y', 'refused', { reason: { code: 'STORYTELLER_IMAGE_UNREADABLE_UNNAMED', params: {} } });
  assert.equal(sendAttention(two, snapshot([item('x', 'done'), refused], 'partial')), 'attention:op', 'an incomplete send opens the pill');
  assert.equal(sendAttention(two, snapshot([refused, { ...refused, exemplarId: 'x-x' }], 'partial')), 'attention:op', 'a send where nothing left opens it');
  const local = { ...context(['n']), operationId: 'local:1', local: true, entries: [], refused: [{ ficheId: 'n', title: 'N', reason: { code: 'NO_EXEMPLAR', params: {} } }] };
  assert.deepEqual(sendOpenKeys([], by, [local, ctx]), ['attention:local:1'], 'a send refused before it started opens it too');
  assert.deepEqual(sendOpenKeys([snapshot([item('x', 'done')], 'success')], () => null), [], 'without a bilan to show, a success opens nothing');
  assert.deepEqual(sendOpenKeys([{ operationKind: 'luniiRepatriate', operationId: 'r', status: 'running' }], by), []);
});

test('activity entries: running detail, bilan in Information, refusals in To fix; local refusals need no operation', () => {
  const ctx = context(['x', 'y']);
  const running = snapshot([item('x', 'copying', { progress: 80 }), item('y', 'pending')]);
  const sends = { contextFor: id => id === 'op' ? ctx : null, contexts: [ctx], devices: [device()], handlers: {} };
  const t = key => key;
  const line = ({ key }) => key;
  const entries = luniiSendEntries(t, line, { sends, running: [running], summaries: [], onCancel() {} });
  assert.deepEqual(entries.map(e => [e.kind, e.tone]), [['running', 'progress']]);
  assert.equal(entries[0].onDismiss, null, 'a running send cannot be dismissed');
  const done = snapshot([item('x', 'done'), item('y', 'refused', { reason: { code: 'STORYTELLER_NAVIGATION_REFUSED', params: {} } })], 'partial');
  const finished = luniiSendEntries(t, line, { sends, running: [], summaries: [done], onDismissSummary() {} });
  assert.deepEqual(finished.map(e => [e.key, e.tone, e.label]), [['send-bilan:op', 'issue', 'catalogue:lunii.sendBilan.partial']], 'one entry per send');
  const local = { ...context(['n']), operationId: 'local:1', local: true, entries: [], refused: [{ ficheId: 'n', title: 'N', reason: { code: 'NO_EXEMPLAR', params: {} } }] };
  const onlyLocal = luniiSendEntries(t, line, { sends: { ...sends, contexts: [local] }, running: [], summaries: [] });
  assert.deepEqual(onlyLocal.map(e => [e.key, e.signature, e.tone, e.label]), [['send-bilan:local:1', 'send-local:local:1', 'issue', 'catalogue:lunii.sendBilan.failed']]);
});

test('store: a send holds the device like a write, then reads the final list once it is released', async () => {
  const calls = [];
  let busy = true;
  const api = { list: async () => { calls.push('list'); const was = busy; busy = false; return [{ id: 'd', busy: was }]; }, inspect: async id => { calls.push('inspect'); return { id, state: 'ready', name: 'N', stories: [{ key: 'a' }], orphans: [], banner: [] }; } };
  const store = createLuniiDevices(api, { read() {}, write() {} }, { setTimeout: fn => { fn(); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d');
  calls.length = 0;
  assert.equal(store.beginSend('d'), null);
  const mid = store.getSnapshot().luniiDevices[0];
  assert.equal(mid.sending, true); assert.equal(mid.busy, true);
  assert.equal(store.beginSend('d'), 'STORYTELLER_DEVICE_BUSY', 'one send at a time per Lunii');
  await store.endSend('d');
  assert.deepEqual(calls, ['list', 'list', 'inspect']);
  const end = store.getSnapshot().luniiDevices[0];
  assert.equal(end.sending, false); assert.equal(end.busy, false); assert.equal(end.stories.length, 1);
  store.select('catalogue', []);
  assert.equal(store.beginSend('missing'), 'STORYTELLER_DEVICE_GONE');
});

test('store: a read-only or damaged Lunii refuses any send, writes included', async () => {
  const api = { inspect: async id => ({ id, state: 'readOnly', stories: [], orphans: [], banner: ['readOnly'] }) };
  const store = createLuniiDevices(api, { read() {}, write() {} });
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d');
  assert.equal(store.beginSend('d'), 'STORYTELLER_READ_ONLY');
  store.reportError({ code: 'X' });
  assert.equal(store.getSnapshot().error.code, 'X');
});

// Expectation changed on purpose: during a send the eject button
// is no longer a silent refusal; it stays active, says it will eject afterwards, and asks.
test('eject stays available during a send, with its own tooltip', () => {
  const tree = render(LuniiPanelHeader, { device: device({ busy: true, sending: true }) });
  const eject = elements(tree).find(e => e.type === Button && e.props['aria-label'] === 'Éjecter');
  assert.equal(eject.props.disabled, false); assert.match(tipOf(tree, eject), /Éjecter après les opérations en cours/);
});

test('header gauge during a drag shows the added size, what remains and the count', () => {
  const over = { count: 2, gauge: dropGauge(device(), { bytes: 226, unknown: 0 }) };
  const tree = render(LuniiPanelHeader, { device: device(), gauge: over });
  const out = text(tree);
  assert.match(out, /\+ .*226.* pour ces 2 histoires/); assert.match(out, /il restera/);
  assert.ok(elements(tree).some(e => e.props?.className === 'lunii-gauge'));
  assert.ok(!elements(tree).some(e => e.type === 'progress'));
});

test('the sending row shows the step, then Copied', () => {
  const row = render(LuniiSendingRow, { story: { key: 'sending:x', position: 4, title: 'X', ficheId: 'x', coverSignature: 's', step: 'generating', progress: 40 } });
  // Deliberate change: the pack generation has no real percentage to show, only its step.
  assert.match(text(row), /génération du pack/);
  assert.doesNotMatch(text(row), /40/);
  assert.match(text(render(LuniiSendingRow, { story: { key: 'sending:x', position: 4, title: 'X', step: 'done', progress: 100 } })), /copiée/);
});

const STEP_LABELS = {
  preparing: /préparation des fichiers/, generating: /génération du pack/, convertingSounds: /conversion des sons/, convertingImages: /conversion des images/,
  encrypting: /chiffrement/, copying: /copie sur la Lunii, 83 %/, finalizing: /finalisation sur la Lunii/,
};
const spinners = tree => elements(tree).filter(e => String(e.props?.className ?? '').includes('lunii-step-spinner'));

test('each step the engine enters has its own label, in the sending row, next to a small spinner', () => {
  for (const [step, label] of Object.entries(STEP_LABELS)) {
    const row = render(LuniiSendingRow, { story: { key: 'sending:x', position: 4, title: 'X', ficheId: 'x', coverSignature: 's', step, progress: 83 } });
    assert.match(text(row), label, step);
    assert.doesNotMatch(text(row), /FFmpeg|catalogue:|\[object/i, step);
    const [spinner, ...others] = spinners(row);
    assert.ok(spinner && !others.length, `${step}: exactly one spinner`);
    assert.equal(spinner.props.width, 12);
    const holder = elements(row).find(e => e.props?.className === 'lunii-sending-step');
    assert.ok(elements(holder).includes(spinner), `${step}: the spinner sits in the step line, beside the label`);
  }
  for (const step of ['pending', 'failed', 'interrupted', 'refused']) {
    const idle = render(LuniiSendingRow, { story: { key: 'sending:x', position: 4, title: 'X', step, progress: 0 } });
    assert.equal(spinners(idle).length, 0, `${step}: no spinner`);
  }
  const active = render(LuniiSendingRow, { story: { key: 'sending:x', position: 4, title: 'X', step: 'encrypting', progress: 5 } });
  const state = elements(active).filter(e => e.props?.role === 'gridcell' && e.props['aria-label']);
  assert.deepEqual(state.map(e => e.props['aria-label']), ['chiffrement'], 'the state cell is named by the current step');
  const done = render(LuniiSendingRow, { story: { key: 'sending:x', position: 4, title: 'X', step: 'done', progress: 100 } });
  assert.equal(spinners(done).length, 0, 'a sent story no longer spins');
});

test('the activity bubble names the current step beside a small spinner, for every step', () => {
  const ctx = context(['x', 'y']);
  const sends = { contextFor: () => ctx, contexts: [ctx], devices: [device()], handlers: {} };
  const t = key => key, line = ({ key }) => key;
  const seen = [];
  for (const step of Object.keys(STEP_LABELS)) {
    const running = snapshot([item('x', step, { progress: 83 }), item('y', 'pending')]);
    const [entry] = luniiSendEntries(t, line, { sends, running: [running], summaries: [], onCancel() {} });
    const tree = render(entry.detail.type, entry.detail.props);
    seen.push(text(tree));
    assert.equal(spinners(tree).length, 1, step);
    assert.match(text(tree), STEP_LABELS[step], step);
  }
  assert.equal(new Set(seen).size, seen.length, 'every step reads differently');
  const idle = snapshot([item('x', 'pending'), item('y', 'pending')]);
  const [entry] = luniiSendEntries(t, line, { sends, running: [idle], summaries: [], onCancel() {} });
  assert.equal(spinners(render(entry.detail.type, entry.detail.props)).length, 0, 'nothing is running yet, nothing spins');
});

test('every active step is the current one of a progress, and each has an i18n key in the three languages', async () => {
  const { ACTIVE_STEPS, sendStepKey, sendNowKey } = await import('../src/store/catalogue/luniiSend.js');
  for (const step of ACTIVE_STEPS) {
    assert.equal(sendProgress(context(['x']), snapshot([item('x', step, { progress: 50 })])).current?.exemplarId, 'x-x', step);
    assert.ok(sendStepKey(step).endsWith(`.sendStep.${step}`), step);
    assert.notEqual(sendStepKey(step), sendStepKey('pending'));
    assert.ok(sendNowKey(step));
  }
  for (const language of ['fr', 'en', 'it']) {
    const messages = JSON.parse(readFileSync(new URL(`../src/locales/${language}/catalogue.json`, import.meta.url), 'utf8'));
    for (const key of [...ACTIVE_STEPS.map(step => sendStepKey(step)), ...ACTIVE_STEPS.map(step => sendNowKey(step))]) assert.ok(messages[key.replace('catalogue:', '')], `${language} ${key}`);
  }
});

// Panel: a drag coming from the catalogue.
function panelHarness(extra = {}) {
  const calls = { hover: [], drop: [], leave: 0 };
  const send = { drag: { cardIds: ['x'] }, over: null, virtualFor: () => [], startDrag() {}, endDrag() {}, hover: (d, key) => { calls.hover.push([d.id, key]); return true; }, drop: async (d, key) => { calls.drop.push([d.id, key]); }, leave: () => calls.leave++, ...extra.send };
  const lunii = { activeLuniiId: 'd', luniiDevices: [device()], selection: { side: 'catalogue', ids: [] }, store: { collapse() {} }, gestures: {}, send, ...extra.lunii };
  return { calls, lunii };
}
// The pointer drag is dnd-kit's: the panel only exposes `data-lunii-drop` surfaces and
// `useLuniiDnd` reads them under the pointer. The tests drive the real handlers on the real surfaces.
const { useLuniiDnd } = await import('../src/hooks/useLuniiDnd.js');
const surface = props => ({ closest: () => ({ dataset: { luniiDrop: props['data-lunii-drop'], deviceId: props['data-device-id'], rowKey: props['data-row-key'] } }) });
const rowSurface = (tree, key) => surface(render(LuniiStoryRow, elements(tree).find(e => e.type === LuniiStoryRow && e.props.story.key === key).props).props);
const headerSurface = tree => surface(render(LuniiPanelHeader, elements(tree).find(e => e.type === LuniiPanelHeader).props).props);
function cardDrag(lunii, onDeviceChange = () => {}) {
  let under = null;
  const app = runner(() => useLuniiDnd({ lunii, sendUi: { drag: { idsFor: id => [id, 'y'] } }, onDeviceChange, elementAt: () => under }));
  const at = { activatorEvent: { clientX: 10, clientY: 10 }, delta: { x: 0, y: 0 } };
  const start = { active: { data: { current: { kind: 'card', cardId: 'x', title: 'X' } } } };
  return { app, hover: surface => { under = surface; app.render().handlers.onDragMove(at); }, start: () => app.render().handlers.onDragStart(start), end: () => app.render().handlers.onDragEnd(at), cancel: () => app.render().handlers.onDragCancel() };
}

test('dropping on a row inserts before it; on the header or the empty area, at the end', () => {
  const { calls, lunii } = panelHarness({ send: { startDrag: ids => calls.started.push(ids), endDrag: () => calls.ended++ } });
  calls.started = []; calls.ended = 0;
  const tree = render(LuniiPanel, { lunii });
  const drag = cardDrag(lunii);
  try {
    drag.start(); assert.deepEqual(calls.started, [['x', 'y']], 'the selection leaves entire');
    drag.hover(rowSurface(tree, 'c')); drag.end();
    assert.deepEqual(calls.hover[0], ['d', 'c']); assert.deepEqual(calls.drop[0], ['d', 'c']);
    drag.start(); drag.hover(headerSurface(tree)); drag.end();
    assert.deepEqual(calls.drop[1], ['d', null]);
    const scroll = elements(tree).find(e => e.props?.className === 'lunii-scroll');
    drag.start(); drag.hover(surface(scroll.props)); drag.end();
    assert.deepEqual(calls.drop[2], ['d', null]);
  } finally { drag.app.unmount(); }
});

test('dropping on another tab switches to it and targets that Lunii; elsewhere writes nothing', () => {
  const other = device({ id: 'e', name: 'Salon' });
  const { calls, lunii } = panelHarness({ lunii: { luniiDevices: [device(), other] }, send: { endDrag: () => calls.ended++ } });
  calls.ended = 0;
  const switched = [];
  const tree = render(LuniiPanel, { lunii, onDeviceChange: id => switched.push(id) });
  const tab = elements(tree).find(e => e.type === 'button' && e.props.role === 'tab' && e.props.id === 'lunii-tab-e');
  const drag = cardDrag(lunii, id => switched.push(id));
  try {
    drag.start(); drag.hover(surface(tab.props)); drag.end();
    assert.deepEqual(calls.drop[0], ['e', null]); assert.deepEqual(switched, ['e']);
    drag.start(); drag.hover(surface(tab.props)); drag.hover(null);
    assert.equal(calls.leave, 1, 'leaving the panel only clears the indicator');
    drag.end();
    assert.equal(calls.drop.length, 1); assert.equal(calls.ended, 1, 'released outside the panel: nothing written');
    drag.start(); drag.hover(surface(tab.props)); drag.cancel();
    assert.equal(calls.drop.length, 1); assert.equal(calls.ended, 2, 'cancelling writes nothing');
  } finally { drag.app.unmount(); }
});

test('a collapsed panel takes a drop at the end of the list', () => {
  const { calls, lunii } = panelHarness({ lunii: { luniiPanelCollapsed: true } });
  const tree = render(LuniiPanel, { lunii });
  const aside = elements(tree).find(e => e.type === 'aside');
  const drag = cardDrag(lunii);
  try { drag.start(); drag.hover(surface(aside.props)); drag.end(); } finally { drag.app.unmount(); }
  assert.deepEqual(calls.drop[0], ['d', null]);
});

test('a row in the middle of a list is a drop surface for catalogue drags and a handle target only when it is a story', () => {
  const { calls, lunii } = panelHarness({ send: { drag: null, virtualFor: () => [{ key: 'sending:x', index: 1, position: 2, title: 'X', step: 'copying', progress: 70 }] } });
  const tree = render(LuniiPanel, { lunii });
  const under = rowSurface(tree, 'b');
  const move = { activatorEvent: { clientX: 10, clientY: 10 }, delta: { x: 0, y: 0 } };
  const app = runner(() => useLuniiDnd({ lunii, sendUi: { drag: { idsFor: id => [id] } }, onDeviceChange() {}, elementAt: () => under }));
  try {
    app.render().handlers.onDragMove(move); // no drag source at all
    app.render().handlers.onDragStart({ active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key: 'a', title: 'A' } } } });
    app.render().handlers.onDragMove(move); // a Lunii row dragged over another row
  } finally { app.unmount(); }
  assert.deepEqual(calls.hover, []);
  assert.deepEqual(elements(tree).filter(e => e.type === LuniiStoryRow || e.type === LuniiSendingRow).map(e => e.props.story.key), ['a', 'sending:x', 'b', 'c']);
  const orphan = render(LuniiStoryRow, { story: { key: 'parked:z', orphan: true }, device: device() });
  assert.equal(orphan.props['data-lunii-drop'], 'orphan'); assert.equal(orphan.props['data-row-key'], undefined);
  assert.equal(rowSurface(tree, 'b').closest().dataset.rowKey, 'b');
});

const { useLuniiSend } = await import('../src/hooks/useLuniiSend.js');
const { useCatalogueOperations } = await import('../src/hooks/useCatalogueOperations.js');
function sendHarness(overrides = {}) {
  const log = { send: [], begin: [], end: [], errors: [], opened: [] };
  const operations = { state: { items: {} }, open: async id => log.opened.push(id), cancel() {} };
  const lunii = { luniiDevices: [device()], store: { beginSend: id => { log.begin.push(id); return overrides.refusal ?? null; }, endSend: async id => { log.end.push(id); }, reportError: error => log.errors.push(error) } };
  lunii.store.enqueueSend = (id, _context, run, settled) => {
    const refusal = lunii.store.beginSend(id);
    if (refusal) { lunii.store.reportError({ code: refusal, params: {} }); return null; }
    // These hook tests inject the historical effect-driven settling adapter.
    // The real independent runner is exercised by luniiQueue.test.mjs.
    return { id: 'queued', finished: run().then(async result => {
      if (result.context.local) { await lunii.store.endSend(id); settled(result); return result.context; }
      result.context.queueOwned = false;
      return result.context;
    }, async error => { lunii.store.reportError(error); await lunii.store.endSend(id); return null; }) };
  };
  const api = { send: async args => { log.send.push(args); if (overrides.reject) throw overrides.reject; return { operationId: 'op' }; } };
  const cards = overrides.cards ?? [card('x'), card('y'), card('n', { exemplars: [], referenceExemplarId: null })];
  const mount = () => runner(() => useLuniiSend({ lunii, operations, cards, revision: 3, chooseExemplar: overrides.choose, api }));
  const app = mount();
  return { app, mount, log, operations, lunii, api };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

for (const status of ['running', 'success', 'failed']) test(`a receipt arriving after remount publishes its context to the active ${status} tracker`, async () => {
  const t = key => key, line = ({ key }) => key;
  const { app, mount, api, operations, log } = sendHarness();
  let accept;
  api.send = () => new Promise(resolve => { accept = resolve; });
  app.render(); app.flush();
  const sending = app.render().sendCards('d', ['x'], 2);
  await tick();
  assert.equal(typeof accept, 'function', 'the engine receipt is still pending');
  app.unmount();
  const snapshot = { operationId: 'op', operationKind: 'luniiSend', status, result: { stories: [{ exemplarId: 'x-x', step: status === 'running' ? 'copying' : status === 'success' ? 'done' : 'failed', progress: 42 }] } };
  operations.state.items.op = snapshot;
  const reopened = mount();
  let hook = reopened.render(); reopened.flush(); reopened.replayEffects();
  assert.equal(hook.contextFor('op'), null);
  accept({ operationId: 'op' });
  const context = await sending;
  hook = reopened.render(); reopened.flush(); await tick();
  hook = reopened.render(); reopened.flush();
  assert.deepEqual(hook.contextFor('op'), context, 'the active mount receives the former mount’s context');
  if (status === 'running') {
    assert.equal(sendProgress(hook.contextFor('op'), snapshot).current.progress, 42);
    const entries = luniiSendEntries(t, line, { sends: hook, running: [snapshot], onCancel: operations.cancel });
    const tracker = render(entries[0].detail.type, entries[0].detail.props);
    assert.ok(elements(tracker).some(e => e.type === Button && e.props.onClick));
  } else {
    assert.equal(luniiSendEntries(t, line, { sends: hook, summaries: [snapshot] }).length, 1);
    assert.equal(hook.sending.size, 0);
    assert.deepEqual(log.end, ['d']);
  }
  reopened.unmount();
});

test('an ongoing send survives leaving the catalogue with its progress and cancellation', async () => {
  const t = key => key, line = ({ key }) => key;
  const { app, mount, operations } = sendHarness();
  const context = await app.render().sendCards('d', ['x'], 2);
  app.render(); app.flush(); app.unmount();
  const snapshot = { operationId: 'op', operationKind: 'luniiSend', status: 'running', result: { stories: [{ exemplarId: 'x-x', step: 'copying', progress: 42 }] } };
  operations.state.items.op = snapshot;
  const reopened = mount();
  const hook = reopened.render(); reopened.flush();
  assert.deepEqual(hook.contextFor('op'), context);
  assert.equal(hook.sending.has('d'), true);
  assert.equal(hook.virtualFor('d').length, 1);
  const entries = luniiSendEntries(t, line, { sends: hook, running: [snapshot], onCancel: operations.cancel });
  const tracker = render(entries[0].detail.type, entries[0].detail.props);
  assert.ok(elements(tracker).some(e => e.type === Button && e.props.onClick), 'cancel remains available');
  reopened.unmount();
});

for (const status of ['success', 'failed', 'cancelled']) test(`a send completed while away restores its ${status} report and settles once`, async () => {
  const t = key => key, line = ({ key }) => key;
  const { app, mount, operations, log } = sendHarness();
  await app.render().sendCards('d', ['x'], 2);
  app.render(); app.flush(); app.unmount();
  const snapshot = { operationId: 'op', operationKind: 'luniiSend', status, result: { stories: [{ exemplarId: 'x-x', step: status === 'success' ? 'done' : 'failed', progress: 100 }] } };
  operations.state.items.op = snapshot;
  let reopened = mount();
  let hook = reopened.render(); reopened.flush(); await tick();
  hook = reopened.render(); reopened.flush();
  assert.equal(hook.sending.size, 0);
  assert.deepEqual(log.end, ['d']);
  assert.equal(luniiSendEntries(t, line, { sends: hook, summaries: [snapshot] }).length, 1);
  reopened.unmount();
  reopened = mount(); hook = reopened.render(); reopened.flush(); await tick();
  assert.deepEqual(log.end, ['d'], 'a later visit must not settle an old send again');
  assert.ok(hook.contextFor('op'), 'the report remains until dismissed');
  operations.state.dismissed = { op: true };
  reopened.render(); reopened.flush();
  hook = reopened.render();
  assert.equal(hook.contextFor('op'), null, 'dismissal releases the retained report context');
  reopened.unmount();
});

for (const status of ['running', 'success', 'failed', 'cancelled']) test(`catalogue recovery restores a ${status} send without events while unmounted`, async () => {
  const t = key => key, line = ({ key }) => key;
  let snapshot = { operationId: 'first', operationKind: 'luniiSend', sequence: 1, status: 'running' };
  let listener = null;
  const catalogue = {
    subscribeOperations: async callback => { listener = callback; return () => { listener = null; }; },
    listOperations: async () => ({ items: [snapshot] }),
    getOperation: async () => snapshot,
    cancelOperation: async () => { snapshot = { ...snapshot, sequence: snapshot.sequence + 1, status: 'cancelling' }; return snapshot; },
  };
  const { lunii, log } = sendHarness();
  let nextId = 'first';
  const api = { send: async () => ({ operationId: nextId }) };
  let operations, send;
  const mount = () => runner(() => {
    operations = useCatalogueOperations({ api: catalogue });
    send = useLuniiSend({ lunii, operations, cards: [card('x'), card('y')], revision: 3, api });
  });
  const pump = async app => { for (let i = 0; i < 4; i++) { app.render(); app.flush(); await tick(); } };
  let app = mount(); await pump(app);
  await send.sendCards('d', ['x'], 2);
  await pump(app); app.unmount();
  assert.equal(listener, null);
  snapshot = { ...snapshot, sequence: 2, status, outcomes: { updated: status === 'success' ? 1 : 0 }, result: { stories: [{ exemplarId: 'x-x', step: status === 'running' ? 'copying' : status === 'success' ? 'done' : 'failed', progress: 75 }] } };
  app = mount(); await pump(app);
  assert.equal(send.contextFor('first').entries[0].title, 'X');
  assert.equal(operations.state.items.first.status, status, 'listOperations recovers the authoritative snapshot');
  if (status === 'running') {
    assert.equal(sendProgress(send.contextFor('first'), operations.state.items.first).current.progress, 75);
    await send.cancel('first'); await pump(app);
    assert.equal(operations.state.items.first.status, 'cancelling');
  } else {
    assert.equal(luniiSendEntries(t, line, { sends: send, summaries: [operations.state.items.first] }).length, 1);
    assert.deepEqual(log.end, ['d']);
    operations.dismiss('first'); await pump(app);
    assert.equal(send.contextFor('first'), null);
    nextId = 'second';
    snapshot = { operationId: nextId, operationKind: 'luniiSend', sequence: 1, status: 'running' };
    await send.sendCards('d', ['y'], 0); await pump(app);
    assert.equal(send.contextFor('second').entries[0].title, 'Y');
    assert.equal(send.contextFor('second').startIndex, 0);
    assert.equal(send.sending.has('d'), true);
    assert.deepEqual(log.end, ['d'], 'the next send does not inherit the former settlement');
  }
  app.unmount();
});

test('leaving during the final device read shares the settlement with the next catalogue mount', async () => {
  const { app, mount, lunii, log, operations } = sendHarness();
  let complete;
  lunii.store.endSend = async id => { log.end.push(id); await new Promise(resolve => { complete = resolve; }); };
  await app.render().sendCards('d', ['x'], null);
  operations.state.items.op = { operationId: 'op', operationKind: 'luniiSend', status: 'success' };
  app.render(); app.flush(); app.unmount();
  const reopened = mount(); reopened.render(); reopened.flush();
  assert.deepEqual(log.end, ['d']);
  complete(); await tick();
  let hook = reopened.render(); reopened.flush();
  assert.equal(hook.sending.size, 0);
  operations.state.dismissed = { op: true };
  reopened.render(); reopened.flush();
  hook = reopened.render();
  assert.equal(hook.contexts.length, 0);
  reopened.unmount();
  const lastVisit = mount(); hook = lastVisit.render(); lastVisit.flush();
  assert.equal(hook.contexts.length, 0);
  assert.deepEqual(log.end, ['d']);
  lastVisit.unmount();
});

test('sendCards passes the explicit targets and a zero-based position, or none for the end', async () => {
  const { app, log } = sendHarness();
  let hook = app.render();
  await hook.sendCards('d', ['x', 'y'], 2);
  await hook.sendCards('d', ['x'], null);
  assert.deepEqual(log.send[0], { deviceId: 'd', selection: [{ exemplarId: 'x-x', expectedRevision: 3 }, { exemplarId: 'y-x', expectedRevision: 3 }], position: 2, requestId: log.send[0].requestId });
  assert.equal(log.send[1].position, null);
  assert.notEqual(log.send[0].requestId, log.send[1].requestId);
  assert.deepEqual(log.opened, ['op', 'op']);
  hook = app.render();
  assert.equal(hook.contexts[0].startIndex, 2); assert.equal(hook.contexts[0].startPosition, 2); assert.equal(hook.contexts[1].startIndex, 3);
  assert.deepEqual(hook.contexts[0].entries.map(e => e.title), ['X', 'Y']);
  app.unmount();
});

test('a busy or refusing Lunii starts nothing; a rejected start releases the device and reports', async () => {
  const refused = sendHarness({ refusal: 'STORYTELLER_DEVICE_BUSY' });
  await refused.app.render().sendCards('d', ['x'], null);
  assert.deepEqual(refused.log.send, []); assert.equal(refused.log.errors[0].code, 'STORYTELLER_DEVICE_BUSY');
  const rejected = sendHarness({ reject: { code: 'STORYTELLER_DEVICE_BUSY' } });
  assert.equal(await rejected.app.render().sendCards('d', ['x'], null), null);
  assert.deepEqual(rejected.log.end, ['d']); assert.equal(rejected.log.errors.length, 1);
});

test('cards without a copy are refused locally, with no engine call, and the device is released', async () => {
  const { app, log } = sendHarness();
  const context = await app.render().sendCards('d', ['n'], null);
  assert.deepEqual(log.send, []); assert.equal(context.local, true); assert.equal(context.refused[0].reason.code, 'NO_EXEMPLAR');
  assert.deepEqual(log.end, ['d']);
  assert.equal(app.render().sending.size, 0);
});

test('when the operation ends, the device is settled once and the rows stop being virtual', async () => {
  const { app, log, operations } = sendHarness();
  let hook = app.render();
  await hook.sendCards('d', ['x'], null);
  hook = app.render(); app.flush();
  assert.equal(hook.sending.has('d'), true); assert.equal(hook.virtualFor('d').length, 1);
  operations.state = { items: { op: { operationId: 'op', operationKind: 'luniiSend', status: 'success', result: { stories: [{ exemplarId: 'x-x', step: 'done', progress: 100 }] } } } };
  hook = app.render(); app.flush(); await tick();
  app.render(); app.flush(); await tick();
  assert.deepEqual(log.end, ['d'], 'settled exactly once');
  hook = app.render();
  assert.equal(hook.sending.has('d'), false); assert.deepEqual(hook.virtualFor('d'), []);
  app.unmount();
});

test('dragging: the hover computes insertion, position and gauge; a drop sends there; refusing devices show nothing', async () => {
  const { app, log, lunii } = sendHarness();
  let hook = app.render();
  hook.startDrag(['x', 'y']);
  hook = app.render();
  assert.equal(hook.hover(lunii.luniiDevices[0], 'c'), true);
  hook = app.render();
  assert.equal(hook.over.index, 2); assert.equal(hook.over.position, 2); assert.equal(hook.over.count, 2); assert.equal(hook.over.gauge.added, 200);
  await hook.drop(lunii.luniiDevices[0], 'c');
  assert.equal(log.send[0].position, 2);
  hook = app.render();
  assert.equal(hook.drag, null); assert.equal(hook.over, null);
  hook.startDrag(['x']); hook = app.render();
  assert.equal(hook.hover(device({ state: 'readOnly' }), 'a'), false);
  await hook.drop(device({ state: 'readOnly' }), 'a');
  assert.equal(log.send.length, 1, 'nothing is written on a read-only Lunii');
  assert.equal(log.errors.at(-1).code, 'STORYTELLER_READ_ONLY');
  hook = app.render(); hook.startDrag(['x']); hook = app.render();
  hook.endDrag(); assert.equal(app.render().drag, null, 'dropping elsewhere writes nothing');
  assert.equal(log.send.length, 1);
  app.unmount();
});

const { useCatalogueSendUi } = await import('../src/hooks/useCatalogueSendUi.js');
test('selection action and context-menu entries follow the open Lunii, with the reason when refused', () => {
  const sent = [];
  const mk = (devices, targets, active = 'd') => {
    const app = runner(() => useCatalogueSendUi({ lunii: { luniiDevices: devices, activeLuniiId: active, store: {}, send: { drag: null, sendCards: (...args) => sent.push(args), startDrag() {}, endDrag() {} } }, targets }));
    try { return app.render(); } finally { app.unmount(); }
  };
  const x = card('x'), y = card('y');
  assert.equal(mk([], [x]).available, false);
  const one = mk([device()], [x, y]);
  assert.equal(one.action.enabled, true); one.runSelection();
  assert.deepEqual(sent[0], ['d', ['x', 'y'], null], 'the whole selection leaves in catalogue order, at the end of the list');
  const readOnly = mk([device({ state: 'readOnly' })], [x]);
  assert.equal(readOnly.action.enabled, false); assert.match(readOnly.action.reasonText, /Story Studio n’y écrira rien|lecture seule/i);
  readOnly.runSelection(); assert.equal(sent.length, 1);
  assert.equal(mk([device()], []).action.enabled, false);
  const entries = one.menuEntries([], { kind: 'card', step: null }, card('fc'));
  assert.equal(entries.length, 1); assert.equal(entries[0].action.enabled, false); assert.match(entries[0].detail, /Déjà sur/);
  const two = mk([device(), device({ id: 'e', name: 'Salon' })], [x]);
  const menu = two.menuEntries([{ key: 'edit' }], { kind: 'card', step: null }, x);
  assert.deepEqual(menu.map(e => e.key), ['edit', 'luniiSend:d', 'luniiSend:e']);
  assert.equal(menu[2].label, 'Envoyer sur Salon');
  assert.equal(two.menuEntries([{ key: 'edit' }], { kind: 'card', step: { action: 'tags' } }, x).length, 1, 'no entry inside a sub-menu');
  two.onSend('x', 'e'); assert.deepEqual(sent.at(-1), ['e', ['x'], null]);
});

test('L9c-2: dismissing a local refusal entry, open() failing after send, and a late release', async () => {
  const onDismissLocal = id => dismissed.push(id);
  const dismissed = [];
  const t = key => key; const line = ({ key }) => key;
  const local = { ...context(['n']), operationId: 'local:1', local: true, entries: [], refused: [{ ficheId: 'n', title: 'N', reason: { code: 'NO_EXEMPLAR', params: {} } }] };
  const entries = luniiSendEntries(t, line, { sends: { contexts: [local], devices: [device()], contextFor: () => null, handlers: {} }, running: [], summaries: [], onDismissLocal });
  assert.equal(entries.length, 1); assert.equal(typeof entries[0].onDismiss, 'function'); entries[0].onDismiss(); assert.deepEqual(dismissed, ['local:1']);

  const { app, log, operations } = sendHarness();
  operations.open = async () => { throw new Error('open failed'); };
  let hook = app.render();
  await hook.sendCards('d', ['x'], null);
  assert.deepEqual(log.end, [], 'accepted send: the reservation is not freed by the failed open');
  assert.equal(log.errors.length, 1);
  operations.state = { items: { op: { operationId: 'op', operationKind: 'luniiSend', status: 'success', result: { stories: [{ exemplarId: 'x-x', step: 'done', progress: 100 }] } } } };
  app.render(); app.flush(); await tick(); app.render(); app.flush(); await tick();
  assert.deepEqual(log.end, ['d'], 'the terminal snapshot releases it once');
  app.unmount();
});

test('L9c-2: the final read is retried while the engine is still busy', async () => {
  let tries = 0; let flaky = false;
  const api = { list: async () => [{ id: 'd', busy: false }], inspect: async id => { tries += 1; if (flaky && tries < 3) throw new Error('busy'); return { id, state: 'ready', name: 'N', stories: [{ key: 'a' }], orphans: [], banner: [] }; } };
  const store = createLuniiDevices(api, { read() {}, write() {} }, { setTimeout: fn => { fn(); return 1; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {} });
  store.reconcile([{ id: 'd', state: 'detected' }]);
  await store.inspect('d');
  tries = 0; flaky = true;
  assert.equal(store.beginSend('d'), null);
  await store.endSend('d', async () => {});
  assert.equal(tries, 3);
  assert.equal(store.getSnapshot().luniiDevices[0].inspected, true);
});

test('D39 the Lunii name shows the fiche fields pencil on hover and focus, which opens the rename', async () => {
  const { Pencil } = await import('../src/components/icons/LucideLocal.jsx');
  const app = runner(() => LuniiPanelHeader({ device: device() }));
  try {
    let tree = app.render();
    const host = elements(tree).find(e => e.props?.className === 'lunii-header-name catalogue-fiche-editable');
    const pencil = elements(host).find(e => e.props?.id === 'lunii-panel-rename');
    assert.equal(pencil.props.className, 'catalogue-fiche-field-action');
    assert.equal(pencil.props['aria-label'], 'Renommer la Lunii…');
    assert.ok(elements(pencil).some(e => e.type === Pencil));
    pencil.props.onClick();
    tree = app.render();
    assert.equal(elements(tree).find(e => e.type === 'input').props.value, 'Lunii d’Armand');
  } finally { app.unmount(); }
  // Refused: still focusable, the tooltip gives the reason, a click does nothing.
  const { Tooltip } = await import('../src/components/common/Tooltip.jsx');
  const { writeReason } = await import('../src/components/Catalogue/lunii/LuniiStoryMenu.jsx');
  const locked = runner(() => LuniiPanelHeader({ device: device({ state: 'readOnly' }) }));
  try {
    const tree = locked.render();
    const pencil = elements(tree).find(e => e.props?.id === 'lunii-panel-rename');
    assert.equal(pencil.props['aria-disabled'], 'true'); assert.equal(pencil.props.disabled, undefined);
    const tooltip = elements(tree).find(e => e.type === Tooltip && elements(e.props.children).includes(pencil));
    assert.equal(tooltip.props.text, writeReason(device({ state: 'readOnly' }), key => key));
    assert.notEqual(tooltip.props.text, 'Renommer la Lunii…'); assert.ok(tooltip.props.text);
    pencil.props.onClick?.();
    assert.ok(!elements(locked.render()).some(e => e.type === 'input'));
  } finally { locked.unmount(); }
});

// Lot « officiels repérés dans le catalogue ».
const { normalizeEntry } = await import('../src/store/catalogue/entryModel.js');
const { OfficialBadge } = await import('../src/components/Catalogue/views/OfficialBadge.jsx');
const { LuniiDragGhost } = await import('../src/components/Catalogue/lunii/LuniiDragGhost.jsx');
const { Tooltip } = await import('../src/components/common/Tooltip.jsx');
const OFFICIAL_REASON = /Histoire Lunii : elle s’installe avec l’application Lunii\./;

test('official: the engine flag reaches the card and its copies; absent means a creation', () => {
  const raw = { id: 'o', official: true, values: { title: 'O' }, exemplars: [{ id: 'o-x', format: 'zip', availability: 'available', official: true, locator: { path: '/o.zip' } }] };
  const official = normalizeEntry(raw);
  assert.equal(official.official, true); assert.equal(official.exemplars[0].official, true);
  const creation = normalizeEntry({ ...raw, official: undefined, exemplars: [{ ...raw.exemplars[0], official: undefined }] });
  assert.equal(creation.official, false); assert.equal(creation.exemplars[0].official, false);
  assert.equal(normalizeEntry({ ...raw, official: 'yes' }).official, false, 'only a real boolean counts');
});

test('official: card and row pill « Officielle », with the explanation as tooltip', () => {
  assert.equal(render(OfficialBadge, { card: { official: false } }), null);
  assert.equal(render(OfficialBadge, { card: {} }), null);
  const tree = render(OfficialBadge, { card: { official: true } });
  assert.equal(tree.type, Tooltip); assert.equal(tree.props.text, 'Histoire officielle Lunii. Story Studio ne peut pas l’envoyer sur ta Lunii.');
  const label = elements(tree).find(e => e.type === 'span');
  assert.match(label.props.className, /catalogue-official-tag/, 'pastille arrondie propre, plus la famille des étiquettes de format');
  assert.equal(text(label).trim(), 'Officielle');
  for (const file of ['CatalogueCard.jsx', 'CatalogueRow.jsx']) {
    assert.match(readFileSync(new URL(`../src/components/Catalogue/views/${file}`, import.meta.url), 'utf8'), /<OfficialBadge card=\{card\} \/>/, `${file} shows the label`);
  }
});

test('official: the Send button of a listed official card is greyed with its reason and a click does nothing', () => {
  const sent = [];
  const listed = normalizeEntry({ id: 'o', official: true, referenceExemplarId: 'o-x', exemplars: [{ id: 'o-x', format: 'zip', availability: 'available', official: true, locator: { path: '/o.zip' } }] });
  const state = sendButtonState(listed, [device()], 'd');
  assert.equal(state.kind, 'official');
  const button = elements(render(LuniiSendButton, { state, onSend: id => sent.push(id) })).find(e => e.type === Button);
  assert.equal(button.props['aria-disabled'], 'true'); assert.equal(button.props.disabled, undefined, 'still focusable for its tooltip');
  assert.match(button.props['aria-label'], OFFICIAL_REASON);
  button.props.onClick({ stopPropagation() {}, detail: 1 });
  assert.deepEqual(sent, []);
});

test('official: dragging only official stories is refused over the target; the drop writes nothing', async () => {
  const { app, log, lunii } = sendHarness({ cards: [card('x'), card('o', { official: true })] });
  let hook = app.render();
  hook.startDrag(['o']); hook = app.render();
  assert.equal(hook.hover(lunii.luniiDevices[0], 'c'), true, 'the target answers, with a refusal');
  hook = app.render();
  assert.deepEqual(hook.over, { deviceId: 'd', refused: 'official' });
  const ghost = render(LuniiDragGhost, { send: hook, cardsById: new Map([['o', card('o', { official: true })]]), active: { kind: 'card' } });
  assert.match(text(ghost), OFFICIAL_REASON); assert.doesNotMatch(text(ghost), /position/i);
  const panel = render(LuniiPanel, { lunii: { luniiDevices: [device()], activeLuniiId: 'd', send: { ...hook, virtualFor: () => [] }, selection: { side: null, ids: [] }, store: {}, luniiPanelCollapsed: false }, width: { value: 330, max: 600 }, onSelect() {}, onDeviceChange() {} });
  assert.doesNotMatch(panel.props.className, /is-drop-target/, 'no insertion highlight'); assert.match(panel.props.className, /is-drop-refused/);
  assert.equal(await hook.drop(lunii.luniiDevices[0], 'c'), null);
  assert.deepEqual(log.send, []); assert.deepEqual(log.begin, [], 'the device is not even reserved'); assert.deepEqual(log.errors, []);
  app.unmount();
});

test('official: a mixed drag or selection sends the others and lists the official ones in the bilan', async () => {
  const { app, log, lunii } = sendHarness({ cards: [card('x'), card('o', { official: true }), card('y')] });
  let hook = app.render();
  hook.startDrag(['x', 'o', 'y']); hook = app.render();
  assert.equal(hook.hover(lunii.luniiDevices[0], null), true);
  hook = app.render();
  assert.equal(hook.over.count, 2); assert.equal(hook.over.gauge.added, 200, 'the gauge counts only what leaves');
  const ctx = await hook.drop(lunii.luniiDevices[0], null);
  assert.deepEqual(log.send[0].selection.map(s => s.exemplarId), ['x-x', 'y-x'], 'the engine never receives the official one');
  assert.deepEqual(ctx.refused, [{ ficheId: 'o', title: 'O', reason: { code: 'STORYTELLER_OFFICIAL_REFUSED', params: {} } }]);
  const report = sendReport(ctx, snapshot([item('x', 'done'), item('y', 'done')], 'success'), [device()]);
  assert.deepEqual(report.done.map(d => d.title), ['X', 'Y']);
  assert.equal(report.refused.length, 1); assert.equal(report.refused[0].presentation.key, 'catalogue:lunii.officialReason');
  app.unmount();
});

test('official: the selection action and the context menu refuse only when nothing may leave', () => {
  const sent = [];
  const mk = targets => {
    const app = runner(() => useCatalogueSendUi({ lunii: { luniiDevices: [device()], activeLuniiId: 'd', store: {}, send: { drag: null, sendCards: (...args) => sent.push(args), startDrag() {}, endDrag() {} } }, targets }));
    try { return app.render(); } finally { app.unmount(); }
  };
  const o = card('o', { official: true }), p = card('p', { official: true }), x = card('x');
  const only = mk([o, p]);
  assert.equal(only.action.enabled, false); assert.match(only.action.reasonText, OFFICIAL_REASON);
  only.runSelection(); assert.deepEqual(sent, []);
  assert.equal(only.menuEntries([], { kind: 'card', step: null }, o)[0].action.enabled, false);
  assert.equal(only.menuEntries([], { kind: 'card', step: null }, o)[0].action.reasonKey, 'catalogue:lunii.officialReason');
  assert.equal(mk([]).menuEntries([], { kind: 'card', step: null }, o)[0].action.enabled, false, 'a lone official card');
  const mixed = mk([x, o]);
  assert.equal(mixed.action.enabled, true); mixed.runSelection();
  assert.deepEqual(sent[0], ['d', ['x', 'o'], null], 'the selection leaves whole; sendCards sets the official one aside');
  assert.equal(mixed.menuEntries([], { kind: 'card', step: null }, o)[0].action.enabled, true, 'the menu of a mixed selection sends the others');
});

// D41: the user picks the copy; a card with several sendable copies asks, the others leave directly.
const multi = (id, extra = {}) => card(id, { exemplars: [{ id: `${id}-a`, available: true, sizeBytes: 10 }, { id: `${id}-b`, available: true, sizeBytes: 20 }], referenceExemplarId: `${id}-a`, ...extra });

test('only copies that can really leave count as a choice', () => {
  const unavailable = { id: 'u-b', available: false };
  assert.equal(needsSendChoice(multi('m'), []), true);
  assert.equal(needsSendChoice(card('s'), []), false, 'a single copy leaves directly');
  assert.equal(needsSendChoice(multi('m', { exemplars: [{ id: 'm-a', available: true }, unavailable] }), []), false, 'an unavailable copy is not a choice');
  assert.equal(needsSendChoice(multi('m', { exemplars: [unavailable, { id: 'u-c', available: false }] }), []), false, 'no copy at all follows the existing refusal');
  assert.equal(needsSendChoice(multi('m', { official: true }), []), false, 'official cards never ask');
  assert.equal(needsSendChoice(multi('m', { uuids: ['U1'] }), [device({ stories: [{ key: 'u1', kind: 'official' }] })]), false, 'official on a device never asks');
  assert.deepEqual(sendableExemplars(multi('m', { exemplars: [{ id: 'm-a', available: true }, unavailable] })).map(e => e.id), ['m-a']);
});

test('the named copy is the one sent; without a choice the reference copy still leaves', () => {
  const m = multi('m');
  assert.equal(buildSelection([m], 7, []).entries[0].selection.exemplarId, 'm-a');
  assert.equal(buildSelection([m], 7, [], new Map([['m', 'm-b']])).entries[0].selection.exemplarId, 'm-b');
  const gone = buildSelection([m], 7, [], new Map([['m', 'nope']]));
  assert.deepEqual([gone.entries.length, gone.skipped.length], [0, 1], 'a copy that vanished sets the card aside');
});

test('boxes come one after the other; cancelling one drops only that card; singles ask nothing', async () => {
  const asked = [];
  const answers = { m1: null, m2: 'm2-b' };
  const result = await resolveSendChoices([multi('m1'), card('s'), multi('m2')], [], async c => { asked.push(c.id); return answers[c.id]; });
  assert.deepEqual(asked, ['m1', 'm2']);
  assert.deepEqual(result.cards.map(c => c.id), ['s', 'm2']);
  assert.deepEqual([...result.chosen], [['m2', 'm2-b']]);
});

test('sendCards: 2 multi-copy cards + 1 single, the first box cancelled -> the 2 others leave with the right copy', async () => {
  const asked = [];
  const answers = { m1: null, m2: 'm2-b' };
  const { app, log } = sendHarness({ cards: [multi('m1'), card('s'), multi('m2')], choose: async c => { asked.push(c.id); return answers[c.id]; } });
  await app.render().sendCards('d', ['m1', 's', 'm2'], null);
  assert.deepEqual(asked, ['m1', 'm2'], 'one box per multi-copy card, in order, none for the single');
  assert.equal(log.send.length, 1);
  assert.deepEqual(log.send[0].selection.map(e => e.exemplarId), ['s-x', 'm2-b']);
  assert.deepEqual(app.render().contexts[0].entries.map(e => e.ficheId), ['s', 'm2'], 'the cancelled card is not even listed in the bilan');
  app.unmount();
});

test('every box cancelled: nothing starts, nothing is reserved, no error', async () => {
  const { app, log } = sendHarness({ cards: [multi('m1'), multi('m2')], choose: async () => null });
  assert.equal(await app.render().sendCards('d', ['m1', 'm2'], null), null);
  assert.deepEqual(log.send, []); assert.deepEqual(log.begin, []); assert.deepEqual(log.errors, []);
  assert.equal(app.render().contexts.length, 0);
  app.unmount();
});

test('a drop keeps its position after the boxes (read on the Lunii as it is then)', async () => {
  const { app, log, lunii } = sendHarness({ cards: [multi('m1'), card('s')], choose: async c => `${c.id}-b` });
  let hook = app.render();
  hook.startDrag(['m1', 's']); hook = app.render();
  await hook.drop(lunii.luniiDevices[0], 'c');
  assert.equal(log.send[0].position, 2);
  assert.deepEqual(log.send[0].selection.map(e => e.exemplarId), ['m1-b', 's-x']);
  app.unmount();
});

const { useSendExemplarChoice } = await import('../src/hooks/useSendExemplarChoice.js');
test('the chooser box opens per card in turn; Annuler/Échap answer null, a click answers the exemplar; disabled copies answer nothing', async () => {
  const app = runner(() => useSendExemplarChoice());
  let hook = app.render();
  const first = hook.ask(multi('m1', { exemplars: [{ id: 'm1-a', available: true }, { id: 'm1-b', available: false }, { id: 'm1-c', available: true }] }));
  const second = hook.ask(multi('m2'));
  await tick(); hook = app.render();
  assert.equal(hook.choice.state.open, true); assert.equal(hook.choice.card.id, 'm1');
  assert.deepEqual(hook.choice.items.map(i => i.enabled), [true, false, true], 'unavailable copies stay listed, disabled');
  assert.equal(hook.choice.state.command, 'send');
  hook.choice.choose(hook.choice.items[1]); // disabled: ignored
  hook = app.render(); assert.equal(hook.choice.card.id, 'm1');
  hook.choice.choose(hook.choice.items[2]);
  assert.equal(await first, 'm1-c');
  await tick(); hook = app.render();
  assert.equal(hook.choice.card.id, 'm2', 'the next box opens only after the first answer');
  hook.choice.cancel();
  assert.equal(await second, null);
  hook = app.render(); assert.equal(hook.choice.state.open, false);
  app.unmount();
});

// D44: a picture found damaged at import marks the copy; the send never takes it.
const damaged = (screen = 'La girafe') => ({ kind: 'image', screen });
const hurt = (id, extra = {}) => card(id, { exemplars: [{ id: `${id}-x`, fileName: `${id}.zip`, available: true, sizeBytes: 100, damagedMedia: damaged() }], ...extra });
const GIRAFFE = /Une image de cette histoire|Image illisible sur l’écran « La girafe »/;

test('damaged: a damaged copy is neither sendable nor a choice; the intact copy leaves alone', () => {
  const mixed = multi('m', { exemplars: [{ id: 'm-a', fileName: 'a.zip', available: true, damagedMedia: damaged() }, { id: 'm-b', available: true }] });
  assert.deepEqual(sendableExemplars(mixed).map(e => e.id), ['m-b']);
  assert.equal(needsSendChoice(mixed, []), false, 'one intact copy is not a choice');
  assert.equal(buildSelection([mixed], 7, []).entries[0].selection.exemplarId, 'm-b', 'the reference copy is damaged: the intact one is sent');
  assert.equal(needsSendChoice(multi('m', { exemplars: [{ id: 'a', available: true }, { id: 'b', available: true }, { id: 'c', available: true, damagedMedia: damaged() }] }), []), true, 'two intact copies still ask');
  assert.equal(sendButtonState(mixed, [device()], 'd').kind, 'ready');
});

test('damaged: the chooser marks the damaged copy, disabled, with the sentence naming the copy and the screen', () => {
  const three = multi('m', { exemplars: [{ id: 'a', fileName: 'a.zip', available: true }, { id: 'b', fileName: 'b.zip', available: true }, { id: 'c', fileName: 'c.zip', available: true, damagedMedia: damaged() }] });
  assert.deepEqual(sendChoiceAvailability(three.exemplars[2]), { enabled: false, reasonKey: 'catalogue:damagedMedia.image', reasonParams: { exemplar: 'c.zip', screen: 'La girafe' } });
  assert.equal(sendChoiceAvailability(three.exemplars[0]).enabled, true);
  const unnamed = { ...three.exemplars[2], damagedMedia: damaged(null) };
  assert.equal(sendChoiceAvailability(unnamed).reasonKey, 'catalogue:damagedMedia.imageUnnamed');
  const items = choiceItems(three.exemplars, sendChoiceAvailability);
  assert.deepEqual(items.map(i => i.enabled), [true, true, false]);
  assert.deepEqual(items[2].reasonParams, { exemplar: 'c.zip', screen: 'La girafe' });
  const panel = render(ExemplarChoicePanel, { choice: { command: 'send', activeIndex: 0 }, card: three, items, dispatch() {}, onChoose() {}, onCancel() {} });
  const options = elements(panel).filter(e => e.props?.item);
  assert.equal(options.length, 3);
  const option = render(options[2].type, options[2].props);
  assert.equal(option.props['aria-disabled'], 'true');
  const reason = elements(option).find(e => e.type === AppTooltip);
  assert.equal(reason.props.text, 'c.zip : une image est abîmée (écran « La girafe »)');
  assert.match(text(render(CompactExemplar, { exemplar: three.exemplars[2] })), /!\s+c\.zip : une image est abîmée/, 'the row itself carries the « ! » and the sentence');
});

test('damaged: when every sendable copy is damaged the button is blocked with the engine reason, and nothing reaches the engine', async () => {
  const h = hurt('h');
  const state = sendButtonState(h, [device()], 'd');
  assert.equal(state.kind, 'blocked'); assert.deepEqual(state.damaged, { code: 'STORYTELLER_IMAGE_UNREADABLE', params: { screen: 'La girafe' } });
  assert.match(text(render(LuniiSendButton, { state })), /^\s*$/);
  const button = render(LuniiSendButton, { state });
  assert.match(button.props.text ?? elements(button).find(e => e.type === AppTooltip)?.props.text ?? '', GIRAFFE);
  assert.equal(sendButtonState(hurt('h', { exemplars: [{ id: 'h-x', available: true, damagedMedia: damaged(null) }] }), [device()], 'd').damaged.code, 'STORYTELLER_IMAGE_UNREADABLE_UNNAMED');
  assert.equal(sendButtonState(card('x', { exemplars: [{ id: 'u', available: false, damagedMedia: damaged() }] }), [device()], 'd').damaged, undefined, 'an unavailable copy keeps the existing reason');
  const { app, log, lunii } = sendHarness({ cards: [h] });
  let hook = app.render();
  hook.startDrag(['h']); hook = app.render();
  assert.equal(hook.hover(lunii.luniiDevices[0], 'c'), true);
  hook = app.render();
  assert.deepEqual(hook.over, { deviceId: 'd', refused: 'damaged', reason: { code: 'STORYTELLER_IMAGE_UNREADABLE', params: { screen: 'La girafe' } } });
  const ghost = render(LuniiDragGhost, { send: hook, cardsById: new Map([['h', h]]), active: { kind: 'card' } });
  assert.match(text(ghost), /La girafe/); assert.doesNotMatch(text(ghost), /position/i);
  assert.equal(await hook.drop(lunii.luniiDevices[0], 'c'), null);
  assert.deepEqual(log.send, []); assert.deepEqual(log.begin, []); assert.deepEqual(log.errors, []);
  app.unmount();
});

test('damaged: a mixed drop sends the others and lists the damaged card with the engine reason and the editor action', async () => {
  const { app, log, lunii } = sendHarness({ cards: [card('x'), hurt('h'), card('o', { official: true })] });
  let hook = app.render();
  hook.startDrag(['x', 'h', 'o']); hook = app.render();
  hook.hover(lunii.luniiDevices[0], null); hook = app.render();
  assert.equal(hook.over.count, 1, 'only what leaves is counted');
  const ctx = await hook.drop(lunii.luniiDevices[0], null);
  assert.deepEqual(log.send[0].selection.map(s => s.exemplarId), ['x-x']);
  assert.deepEqual(ctx.refused.map(r => [r.ficheId, r.reason.code]), [['h', 'STORYTELLER_IMAGE_UNREADABLE'], ['o', 'STORYTELLER_OFFICIAL_REFUSED']]);
  assert.deepEqual(ctx.refused[0].reason.params, { screen: 'La girafe' });
  assert.equal(refusalPresentation(ctx.refused[0].reason).action, 'editor');
  app.unmount();
});

test('damaged: a card with an intact copy is not refused at the drop', async () => {
  const { app, log, lunii } = sendHarness({ cards: [card('ok', { exemplars: [{ id: 'ok-a', available: true, damagedMedia: damaged() }, { id: 'ok-b', available: true }], referenceExemplarId: 'ok-a' })] });
  let hook = app.render();
  hook.startDrag(['ok']); hook = app.render();
  await hook.drop(lunii.luniiDevices[0], null);
  assert.deepEqual(log.send[0].selection.map(s => s.exemplarId), ['ok-b']);
  app.unmount();
});

test('damaged: the selection action and the menu refuse only when nothing may leave, with the damaged reason', () => {
  const mk = targets => {
    const app = runner(() => useCatalogueSendUi({ lunii: { luniiDevices: [device()], activeLuniiId: 'd', store: {}, send: { drag: null, sendCards() {}, startDrag() {}, endDrag() {} } }, targets }));
    try { return app.render(); } finally { app.unmount(); }
  };
  const only = mk([hurt('h')]);
  assert.equal(only.action.enabled, false); assert.match(only.action.reasonText, /La girafe/);
  const entry = only.menuEntries([], { kind: 'card', step: null }, hurt('h'))[0];
  assert.equal(entry.action.enabled, false); assert.match(entry.detail, /La girafe/);
  assert.equal(mk([hurt('h'), card('x')]).action.enabled, true);
});

test('explicit notStarted rows retain titles, settle progress and expose the Rust deviceFault', () => {
  const ctx = context(['x', 'y', 'z']);
  const snap = snapshot([
    item('x', 'done', { deviceFault: false }),
    item('y', 'refused', { deviceFault: true, reason: { code: 'STORYTELLER_NO_SPACE', params: { missingBytes: 42 } } }),
    item('z', 'notStarted', { deviceFault: false }),
  ], 'partial');
  const report = sendReport(ctx, snap);
  assert.equal(report.deviceFault, true);
  assert.deepEqual(report.notStarted.map(story => story.title), ['Z']);
  assert.equal(report.refused[0].deviceFault, true);
  assert.match(text(render(LuniiSendBilan, { report })), /Non lancée : « Z »/);
  assert.equal(sendProgress(ctx, snap).percent, 100);
  assert.equal(sendProgress(ctx, snap).settled, 3);
  assert.deepEqual(virtualRows(ctx, snap).map(row => row.title), ['X']);
  assert.ok(virtualRows(ctx, snapshot([item('z', 'notStarted')], 'partial')).length === 0);
  const packFailure = snapshot([item('x', 'failed', { deviceFault: false, reason: { code: 'STORYTELLER_WRITE_FAILED', params: {} } })], 'partial');
  assert.equal(sendReport(ctx, packFailure).deviceFault, false, 'no JS heuristic on WRITE_FAILED');
});


test('not-started translations agree across plurals and omit the unused step label', () => {
  for (const language of ['fr', 'en', 'it']) {
    const messages = JSON.parse(readFileSync(new URL(`../src/locales/${language}/catalogue.json`, import.meta.url), 'utf8'));
    assert.equal(messages['lunii.sendBilan.notStarted_many'], messages['lunii.sendBilan.notStarted_other']);
    assert.equal(messages['lunii.sendStep.notStarted'], undefined);
    if (language === 'it') assert.equal(messages['lunii.sendBilan.notStarted_one'], 'Non avviata: «{{titles}}».');
  }
});

test('real queue: sends and a second gesture finish after catalogue unmount, keeping each send report', async () => {
  const calls = [], gates = new Map();
  const api = {
    list: async () => [{ id: 'd', state: 'ready', busy: false }],
    inspect: async () => device(),
    send: async args => { calls.push(['send', args.position]); return { operationId: args.requestId }; },
    getOperation: id => new Promise(resolve => gates.set(id, resolve)),
    rename: async (_id, name) => { calls.push(['rename', name]); return { device: device() }; },
  };
  const store = createLuniiDevices(api, { read() {}, write() {} });
  store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
  const operations = { state: { items: {} }, open: async id => { operations.state.items[id] = { operationId: id, status: 'running' }; }, cancel: id => { calls.push(['cancel', id]); return true; }, release() {}, retain() {} };
  const mount = () => runner(() => useLuniiSend({ lunii: { ...store.getSnapshot(), store }, operations, cards: [card('x'), card('y')], revision: 1, api }));
  const app = mount(); app.render(); app.flush();
  const first = app.render().sendCards('d', ['x'], 2); await tick();
  const second = app.render().sendCards('d', ['y'], 1); await tick();
  const third = store.mutate('d', 'rename', ['Bedroom']);
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['running', 'queued', 'queued']);
  assert.equal(store.queued(), 2);
  assert.deepEqual(calls, [['send', 2]]);
  const current = app.render();
  const currentId = current.contexts[0].operationId;
  assert.equal(current.contexts[0].queueEntryId, store.getQueueReport().d[0].id, 'the operation context names its own queue entry');
  const [entry] = luniiSendEntries(key => key, ({ key }) => key, { sends: current, running: [{ operationId: currentId, operationKind: 'luniiSend', status: 'running' }], onCancel: id => current.cancel(id) });
  const tracker = render(entry.detail.type, entry.detail.props);
  const cancel = elements(tracker).find(e => e.type === Button && e.props.onClick);
  assert.ok(cancel, 'explicit cancellation stays available for the running queued send');
  cancel.props.onClick();
  assert.deepEqual(calls.pop(), ['cancel', currentId]);
  app.unmount();
  gates.values().next().value({ status: 'cancelled', result: { stories: [{ step: 'interrupted', deviceFault: false }] } });
  await first; await tick();
  assert.deepEqual(calls, [['send', 2], ['send', 1]]);
  [...gates.values()].at(-1)({ status: 'success', result: { stories: [{ step: 'done', deviceFault: false }] } });
  await Promise.all([second, third]);
  const reopened = mount(); reopened.render(); reopened.flush();
  const send = reopened.render();
  assert.equal(send.contexts.length, 2);
  assert.equal(send.sending.size, 0);
  assert.deepEqual(store.getQueueReport().d.map(e => e.state), ['failed', 'done', 'done']);
  assert.equal(store.getSnapshot().error, null);
  assert.deepEqual(calls, [['send', 2], ['send', 1], ['rename', 'Bedroom']]);
  reopened.unmount();
});

for (const removeNeighbour of [false, true]) test(`queued sends resolve neighbour on reread (removed=${removeNeighbour})`, async () => {
  let stories = [{ key: 'a' }, { key: 'x' }, { key: 'z' }];
  const calls = [], gates = [];
  const api = {
    list: async () => [{ id: 'd', busy: false }],
    inspect: async () => ({ ...device(), stories: structuredClone(stories) }),
    send: async args => {
      calls.push(args.position);
      stories.splice(args.position, 0, { key: `sent-${calls.length}` });
      return { operationId: `op-${calls.length}` };
    },
    getOperation: () => new Promise(resolve => gates.push(resolve)),
  };
  const store = createLuniiDevices(api, { read() {}, write() {} });
  store.reconcile([{ id: 'd', state: 'detected' }]); await store.inspect('d');
  const operations = { state: { items: {} }, open: async () => {} };
  const app = runner(() => useLuniiSend({ lunii: { ...store.getSnapshot(), store }, operations, cards: [card('a'), card('b')], revision: 1, api }));
  app.render(); app.flush();
  const first = app.render().drop(store.getSnapshot().luniiDevices[0], 'x', ['a']); await tick();
  const second = app.render().drop(store.getSnapshot().luniiDevices[0], 'x', ['b']); await tick();
  if (removeNeighbour) stories = stories.filter(story => story.key !== 'x');
  gates.shift()({ status: 'success' }); await first; await tick();
  assert.deepEqual(calls, [1, removeNeighbour ? 1 : 2]);
  const ctx = app.render().contexts[1];
  assert.equal(ctx.startIndex, removeNeighbour ? 1 : 2);
  assert.equal(ctx.startPosition, removeNeighbour ? 2 : 3);
  gates.shift()({ status: 'success' }); await second;
  assert.deepEqual(stories.map(story => story.key), removeNeighbour ? ['a', 'sent-2', 'sent-1', 'z'] : ['a', 'sent-1', 'sent-2', 'x', 'z']);
  app.unmount();
});

test('incomplete project: structured missing files give a short localized summary and open the right editor', async () => {
  const { default: i18next } = await import('i18next');
  const resources = Object.fromEntries(['fr', 'en', 'it'].map(language => [language, {
    catalogue: JSON.parse(readFileSync(new URL(`../src/locales/${language}/catalogue.json`, import.meta.url), 'utf8')),
  }]));
  await i18next.init({ lng: 'fr', keySeparator: false, resources, interpolation: { escapeValue: false } });
  const missing = { code: 'FILES_NOT_FOUND_OR_INACCESSIBLE', params: { label: 'secret.mp3', error: "Le chemin d'accès spécifié est introuvable. (os error 3)" } };
  const reasonFor = cause => ({ code: 'STORYTELLER_PROJECT_INCOMPLETE', params: { cause } });
  const cause = { code: 'VALIDATION_PROJECT_ERRORS', params: { errors: { messages: [missing, missing, missing, { code: 'VALIDATION_PROJECT_TARGET_MISSING', params: {} }], separator: '\n' } } };
  const expected = {
    fr: ['Projet pas prêt pour la Lunii : 3 fichiers manquants. Ouvre-le pour le terminer.', 'Ouvrir le projet'],
    en: ['Project not ready for the Lunii: 3 missing files. Open it to finish it.', 'Open project'],
    it: ['Progetto non pronto per la Lunii: 3 file mancanti. Aprilo per completarlo.', 'Apri il progetto'],
  };
  try {
    for (const language of ['fr', 'en', 'it']) {
      await i18next.changeLanguage(language);
      const reason = reasonFor(cause);
      const presentation = refusalPresentation(reason);
      assert.deepEqual(presentation.params, { count: 3 }, 'only file failures count, not navigation errors');
      assert.equal('cause' in presentation, false, 'raw cause never reaches the card presentation');
      const opened = [];
      const tree = render(LuniiSendRefusals, { report: { refused: [], failed: [{ ficheId: 'project-42', title: 'My project', reason, presentation }] }, handlers: { openEditor: id => opened.push(id) } });
      assert.ok(text(tree).includes(expected[language][0]));
      assert.doesNotMatch(text(tree), /os error|introuvable|secret\.mp3|FILES_NOT_FOUND/);
      const button = elements(tree).find(element => element.type === Button);
      assert.equal(text(button), expected[language][1]);
      button.props.onClick();
      assert.deepEqual(opened, ['project-42']);
      for (const unknown of [null, 'raw os error 3', { code: 'STORYTELLER_PROJECT_INVALID' }, { code: 'VALIDATION_PROJECT_ERRORS', params: { errors: { messages: [] } } }]) {
        const fallback = refusalPresentation(reasonFor(unknown));
        assert.deepEqual(fallback.params, {});
        assert.equal(fallback.key, 'catalogue:lunii.sendRefused.incomplete');
        const fallbackTree = render(LuniiSendRefusals, { report: { refused: [{ ficheId: 'project-42', reason: reasonFor(unknown), presentation: fallback }], failed: [] } });
        assert.ok(text(fallbackTree).includes(i18next.t('catalogue:lunii.sendRefused.incomplete')));
        assert.doesNotMatch(text(fallbackTree), /os error|undefined|null/);
      }
      const single = refusalPresentation(reasonFor(missing));
      assert.deepEqual(single.params, { count: 1 });
      assert.ok(i18next.t(single.key, single.params).includes('1'));
    }
  } finally { await i18next.changeLanguage('fr'); }
});
