import test from 'node:test';
import assert from 'node:assert/strict';
import { createLuniiGestures, luniiConfirmation } from '../src/store/catalogue/luniiGestures.js';
import { createTestI18n } from './i18nTestSetup.mjs';
const engine = createTestI18n();
const t = engine.getFixedT('fr');
const a = { key: 'a', title: 'A', kind: 'creation' }, b = { key: 'b', title: 'B', kind: 'official' }, c = { key: 'c', kind: 'unknown', hidden: true };
const device = { id: 'd', state: 'ready', stories: [a, b, c] };
function setup(accept = true) {
  const calls = [], confirms = [], announcements = [];
  const gestures = createLuniiGestures({ store: { mutate: async (...args) => { calls.push(args); return {}; } } }, t, async (...args) => { confirms.push(args); return accept; }, message => announcements.push(message));
  return { calls, confirms, gestures, announcements };
}

test('eye, hide selection, restore, name, rename, reorder and repatriate dispatch exact gestures', async () => {
  const { gestures: g, calls, confirms, announcements } = setup();
  await g.hide(device, a); await g.hide(device, c); await g.hideMany(device, [a, c]);
  await g.restore(device); await g.name(device, c, 'Conte'); await g.rename(device, 'Salon');
  await g.orphan(device, { key: 'parked:ABCDEF00', knownUuid: 'full-id' });
  await g.repatriate(device, [a, b, c]); await g.reorder(device, ['c'], 0);
  assert.deepEqual(calls, [
    ['d', 'hide', ['a', true], ['a'], { a: 'A' }], ['d', 'hide', ['c', false], ['c'], { c: '' }],
    ['d', 'hideMany', [true], ['a'], { a: 'A' }], ['d', 'restore'], ['d', 'nameStory', ['c', 'Conte'], ['c'], { c: '' }], ['d', 'rename', ['Salon']],
    ['d', 'orphan', [{ deviceId: 'd', key: 'parked:ABCDEF00', restore: true, knownUuid: 'full-id' }], ['parked:ABCDEF00'], { 'parked:ABCDEF00': '' }],
    ['d', 'repatriateMany', [], ['a', 'c'], { a: 'A', c: '' }], ['d', 'reorder', [{ rowKey: 'a', index: 0 }], ['c'], { c: '' }],
  ]);
  assert.equal(confirms.length, 0); assert.match(announcements[0], /position 1 sur 2/);
});

test('only a single creation can be removed without confirmation; official and multiple each ask once with names', async () => {
  for (const [stories, force, expected] of [[[a], false, 0], [[b], false, 1], [[a, b], false, 1], [[a], true, 1]]) {
    const { gestures, calls, confirms } = setup();
    await gestures.remove(device, stories, force);
    assert.equal(confirms.length, expected); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['d', 'remove', [stories.map(s => s.key)], stories.map(s => s.key), Object.fromEntries(stories.map(s => [s.key, s.title]))]);
    if (stories.includes(b)) { assert.match(confirms[0][1], /B/); assert.match(confirms[0][1], /seule l’application Lunii/); }
  }
});

test('delete orphan asks once with reclaimed size; cancelling performs no write', async () => {
  const orphan = { key: 'parked:ABCDEF00', title: 'Perle', orphan: true, sizeBytes: 100 };
  const { gestures, calls, confirms } = setup(); await gestures.remove(device, [orphan]);
  assert.equal(confirms.length, 1); assert.match(confirms[0][0], /Perle/); assert.match(confirms[0][1], /100/);
  assert.deepEqual(calls[0], ['d', 'orphan', [{ deviceId: 'd', key: orphan.key, restore: false }], [orphan.key], { [orphan.key]: 'Perle' }]);
  const cancelled = setup(false); await cancelled.gestures.remove(device, [orphan]); assert.equal(cancelled.calls.length, 0);
});

test('empty repair confirmation explicitly announces an empty list; cancel never repairs', async () => {
  const damaged = { ...device, state: 'damaged', repairPreview: { kept: 0, removed: ['x'], empty: true } };
  for (const accepted of [false, true]) {
    const { gestures, confirms, calls } = setup(accepted); await gestures.repair(damaged);
    assert.equal(confirms.length, 1); assert.match(confirms[0][1], /La liste sera vide/);
    assert.equal(calls.length, accepted ? 1 : 0);
  }
});


test('Lunii confirmation gives initial focus to Cancel and uses a single action pair', () => {
  const dialog = luniiConfirmation(t, 'Title', 'Message', 'Repair', 'primary-violet');
  assert.equal(dialog.variant, 'lunii'); assert.equal(dialog.actions.length, 2);
  assert.equal(dialog.actions[0].label, 'Annuler'); assert.equal(dialog.actions[0].autoFocus, true);
  assert.equal(dialog.actions[0].value, false); assert.equal(dialog.actions[1].kind, 'primary-violet');
});

test('move announcement counts visible stories only, like the displayed numbers', async () => {
  const { gestures, calls, announcements } = setup();
  await gestures.reorder(device, ['a'], 3);
  assert.deepEqual(calls[0][2], [{ rowKey: null, index: 3 }]);
  assert.match(announcements[0], /A, position 2 sur 2/);
});

test('orphan selections delete after one confirmation; mixed selections announce both effects once', async () => {
  const perle = { key: 'parked:ABCDEF00', title: 'Perle', orphan: true, sizeBytes: 100 };
  const coquille = { key: 'ABCDEF01', title: 'Coquille', orphan: true, sizeBytes: 50 };
  const orphans = setup(); await orphans.gestures.remove(device, [perle, coquille], true);
  assert.equal(orphans.confirms.length, 1);
  assert.match(orphans.confirms[0][0], /Supprimer 2 histoires/); assert.match(orphans.confirms[0][1], /Perle, Coquille/);
  assert.equal(orphans.confirms[0][2], 'Supprimer');
  assert.deepEqual(orphans.calls.map(c => c[1]), ['orphan', 'orphan']);
  assert.deepEqual(orphans.calls.map(c => c[3]), [[perle.key], [coquille.key]]);
  const mixed = setup(); await mixed.gestures.remove(device, [a, b, perle], true);
  assert.equal(mixed.confirms.length, 1);
  const [title, message] = mixed.confirms[0];
  assert.match(title, /Retirer et supprimer 3 histoires/);
  assert.match(message, /Retirées de la liste de l’enfant : A, B/); assert.match(message, /Supprimées de la Lunii.*Perle/);
  assert.match(message, /seule l’application Lunii/); assert.match(message, /100/);
  assert.deepEqual(mixed.calls, [['d', 'remove', [['a', 'b']], ['a', 'b'], { a: 'A', b: 'B' }], ['d', 'orphan', [{ deviceId: 'd', key: perle.key, restore: false }], [perle.key], { [perle.key]: 'Perle' }]]);
  const cancelled = setup(false); await cancelled.gestures.remove(device, [a, perle], true); assert.equal(cancelled.calls.length, 0);
});

// Expectation changed on purpose (L3b, file d'opérations Lunii): the whole gesture is queued
// at once so that every story shows its waiting removal; like any queued entry, a failed
// removal no longer holds back the orphans (only a fault of the Lunii stops the queue).
test('a mixed removal queues the listed write and every orphan at once, listed first', async () => {
  const calls = [];
  const gestures = createLuniiGestures({ store: { mutate: (...args) => { calls.push(args); return Promise.resolve(null); } } }, t, async () => true, () => {});
  await gestures.remove(device, [a, { key: 'ABCDEF01', title: 'Coquille', orphan: true, sizeBytes: 1 }], true);
  assert.deepEqual(calls.map(c => c[1]), ['remove', 'orphan']);
});

test('repatriate leaves out stories the catalogue already holds, officials and orphans', async () => {
  const { gestures: g, calls } = setup();
  const present = { key: 'p', kind: 'creation', catalogueFicheId: 'fiche' }, orphan = { key: 'parked:x', orphan: true };
  await g.repatriate(device, [a, b, c, present, orphan]);
  assert.deepEqual(calls, [['d', 'repatriateMany', [], ['a', 'c'], { a: 'A', c: '' }]]);
});

test('restoreOrphans keeps only complete, identified .content orphans, without confirmation', async () => {
  const { gestures: g, calls, confirms } = setup();
  const orphans = [
    { key: '00000005', complete: true, knownUuid: 'e' },
    { key: '00000004', complete: false, knownUuid: 'd' },
    { key: 'parked:00000006', parked: true, complete: true, knownUuid: 'f' },
    { key: '00000007', complete: true, knownUuid: null },
    { key: '00000003', complete: true, knownUuid: 'c' },
  ];
  await g.restoreOrphans({ ...device, orphans });
  assert.equal(confirms.length, 0);
  assert.deepEqual(calls, [['d', 'restoreOrphans', [[{ key: '00000005', knownUuid: 'e' }, { key: '00000003', knownUuid: 'c' }]], ['00000005', '00000003'], { '00000005': '', '00000003': '' }]]);
  assert.equal(await g.restoreOrphans({ ...device, orphans: orphans.slice(1, 4) }), null);
  assert.equal(calls.length, 1);
});
