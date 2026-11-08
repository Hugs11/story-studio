import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuniiDevices, withCardTitles } from '../src/store/catalogue/luniiDevices.js';
import { cardTitle, normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { buildSelection, sendBilanKind, sendContext, sendReport } from '../src/store/catalogue/luniiSend.js';
import { createLuniiGestures } from '../src/store/catalogue/luniiGestures.js';
import { createTestI18n } from './i18nTestSetup.mjs';

const t = createTestI18n().getFixedT('fr');
const settings = { read() {}, write() {} };
// The card shows « Le Petit Nuage »; the archive and the device know the pack as a derived file name.
const FILE_NAME = 'Les-aventures-du-petit-nuage';
const exemplar = id => ({ id, format: 'project', availability: 'available', path: 'C:\\sauvegardes\\' + FILE_NAME + '.mbah', sizeBytes: 10 });
const card = normalizeEntry({ id: 'f1', values: { title: 'Le Petit Nuage' }, exemplars: [exemplar('e1')] });
const other = normalizeEntry({ id: 'f2', values: { title: 'Aladin - Aladin' }, exemplars: [exemplar('e2')] });
const untitled = normalizeEntry({ id: 'f3', exemplars: [exemplar('e3')] });
const base = { id: 'd', name: 'Ma Lunii', state: 'ready', busy: false, banner: [] };
const item = (exemplarId, step, extra = {}) => ({ exemplarId, step, progress: 0, reason: null, deviceFault: false, ...extra });
const snapshot = (stories, status) => ({ status, result: { stories } });
const linked = (key, extra = {}) => ({ key, title: FILE_NAME, kind: 'creation', catalogueFicheId: 'f1', ...extra });

test('the card title is the one every operation names', () => {
  assert.equal(cardTitle(card), 'Le Petit Nuage');
  assert.equal(cardTitle(other), 'Aladin');
  assert.equal(cardTitle(untitled), null);
});

test('send: the running line, the bilan and every outcome carry the card title, not the file name', () => {
  const { entries } = buildSelection([card, other], 1);
  const context = sendContext({ operationId: 'op', device: { ...base, stories: [] }, startIndex: 0, cards: [card, other], entries });
  assert.deepEqual(context.entries.map(e => e.title), ['Le Petit Nuage', 'Aladin']);
  const done = sendReport(context, snapshot([item('e1', 'done'), item('e2', 'done')], 'success'));
  assert.deepEqual(done.done.map(d => d.title), ['Le Petit Nuage', 'Aladin']);
  const failed = sendReport(context, snapshot([item('e1', 'failed', { reason: { code: 'STORYTELLER_WRITE_FAILED', params: {} } }), item('e2', 'notStarted')], 'partial'));
  assert.equal(failed.failed[0].title, 'Le Petit Nuage');
  assert.equal(failed.notStarted[0].title, 'Aladin');
  const cut = sendReport(context, snapshot([item('e1', 'interrupted', { reason: { code: 'STORYTELLER_SEND_DISCONNECTED', params: {} } }), item('e2', 'pending')], 'failed'));
  assert.equal(cut.interrupted.title, 'Le Petit Nuage');
  assert.equal(sendBilanKind(cut).kind, 'interrupted');
  const refused = sendContext({ operationId: 'op2', device: { ...base, stories: [] }, startIndex: 0, cards: [card], entries: [], skipped: [card] });
  assert.equal(sendReport(refused, null).refused[0].title, 'Le Petit Nuage');
});

test('stories and orphans linked to a card are named by the card; unlinked, unknown and unmatched ones keep their own name', () => {
  const stories = [linked('A'), linked('O', { kind: 'official' }), { key: 'B', title: 'Hors catalogue' }, linked('C', { catalogueFicheId: 'inconnue', title: 'Gardé' }), linked('U', { kind: 'unknown', title: null }), linked('N', { catalogueFicheId: 'f3' })];
  const orphans = [linked('X', { orphan: true, complete: true, kind: 'creation' }), linked('Y', { catalogueFicheId: 'f2' })];
  const [named] = withCardTitles([{ ...base, stories, orphans }], [card, other, untitled]);
  assert.deepEqual(named.stories.map(s => s.title), ['Le Petit Nuage', 'Le Petit Nuage', 'Hors catalogue', 'Gardé', null, FILE_NAME]);
  assert.deepEqual(named.orphans.map(s => s.title), ['Le Petit Nuage', 'Aladin']);
  assert.equal(named.stories[2], stories[2]);
});

const decorated = (stories, orphans = []) => withCardTitles([{ ...base, stories, orphans }], [card, other])[0];

test('gestures hand the displayed names to the queue: remove, hide, reorder, orphans, repatriate', async () => {
  const device = decorated([linked('A'), linked('B', { catalogueFicheId: 'f2' }), { key: 'C', title: 'Hors catalogue', kind: 'creation' }], [linked('X', { orphan: true, complete: true, knownUuid: 'u' })]);
  const writes = [];
  const gestures = createLuniiGestures({ store: { mutate: async (...args) => { writes.push(args); return {}; } } }, t, async () => true, () => {});
  await gestures.remove(device, [device.stories[0], device.orphans[0]], true);
  await gestures.hide(device, device.stories[1]);
  await gestures.hideMany(device, [device.stories[0], device.stories[2]]);
  await gestures.reorder(device, ['B'], 0);
  await gestures.restoreOrphans(device);
  await gestures.orphan(device, device.orphans[0]);
  await gestures.repatriate(device, [device.stories[2]]);
  assert.deepEqual(writes.map(w => [w[1], w[4]]), [
    ['remove', { A: 'Le Petit Nuage' }], ['orphan', { X: 'Le Petit Nuage' }], ['hide', { B: 'Aladin' }], ['hideMany', { A: 'Le Petit Nuage', C: 'Hors catalogue' }],
    ['reorder', { B: 'Aladin' }], ['restoreOrphans', { X: 'Le Petit Nuage' }], ['orphan', { X: 'Le Petit Nuage' }], ['repatriateMany', { C: 'Hors catalogue' }],
  ]);
});

async function store(stories, orphans = []) {
  const actual = { ...base, stories, orphans };
  const answer = () => ({ device: structuredClone(actual), outcomes: [] });
  const api = { inspect: async () => structuredClone(actual), remove: answer, hide: answer, nameStory: answer, reorder: answer, orphan: answer, restoreOrphans: answer };
  const lunii = createLuniiDevices(api, settings, globalThis, async () => '/workspace');
  lunii.reconcile([{ id: 'd', state: 'detected' }]);
  await lunii.inspect('d');
  return lunii;
}
const titlesOf = lunii => lunii.getSnapshot().luniiQueue.d.map(entry => entry.title);

test('the queue entries carry the displayed name through the real gestures, never the file name', async () => {
  const raw = [linked('A'), linked('B', { catalogueFicheId: 'f2' }), { key: 'C', title: 'Hors catalogue', kind: 'creation' }];
  const rawOrphans = [linked('X', { complete: true, knownUuid: 'u' })];
  const lunii = await store(raw, rawOrphans);
  const device = decorated(raw, rawOrphans);
  const gestures = createLuniiGestures({ store: lunii }, t, async () => true, () => {});
  await gestures.remove(device, [device.stories[0], device.stories[2]], true);
  await gestures.hide(device, device.stories[1]);
  await gestures.reorder(device, ['A'], 2);
  await gestures.restoreOrphans(device);
  await gestures.orphan(device, device.orphans[0]);
  assert.deepEqual(titlesOf(lunii), ['Le Petit Nuage, Hors catalogue', 'Aladin', 'Le Petit Nuage', 'Le Petit Nuage', 'Le Petit Nuage']);
});

test('an unknown row keeps its own name and a renaming queues the new name', async () => {
  const raw = [linked('U', { kind: 'unknown', title: null })];
  const device = decorated(raw);
  assert.equal(device.stories[0].title, null);
  const lunii = await store(raw);
  const gestures = createLuniiGestures({ store: lunii }, t, async () => true, () => {});
  await gestures.name(device, device.stories[0], 'Nouveau nom');
  assert.deepEqual(titlesOf(lunii), ['Nouveau nom']);
});

test('a card without a title leaves the device name, in the panel and in the queue alike', async () => {
  const raw = [linked('N', { catalogueFicheId: 'f3' })];
  const device = withCardTitles([{ ...base, stories: raw, orphans: [] }], [untitled])[0];
  assert.equal(device.stories[0].title, FILE_NAME);
  const lunii = await store(raw);
  const gestures = createLuniiGestures({ store: lunii }, t, async () => true, () => {});
  await gestures.hide(device, device.stories[0]);
  assert.deepEqual(titlesOf(lunii), [FILE_NAME]);
});
