import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
const { useCatalogueTrash } = await import('../src/hooks/useCatalogueTrash.js');
const { useCatalogueImport } = await import('../src/hooks/useCatalogueImport.js');
const { useCatalogueBackup } = await import('../src/hooks/useCatalogueBackup.js');
const { useCatalogueSelectionActions } = await import('../src/hooks/useCatalogueSelectionActions.js');
const { useCatalogueAssembly } = await import('../src/hooks/useCatalogueAssembly.js');
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const expired = { code: 'CATALOG_OPERATION_EXPIRED' };
function mount(fn) { let hook; const app = runner(() => { hook = fn(); }); const render = () => { app.render(); app.flush(); }; render(); return { app, render, get hook() { return hook; } }; }
test('permanent removal consumes two engine stages in one gesture, armed for 400 ms', async () => {
  let clock = 0; let starts = 0; const confirmations = [];
  const plan = { planId: 'plan', action: 'deletePermanently', targets: [{ sourceToken: 'source' }] };
  const filesApi = { plan: async () => plan, confirmRemoval: async (planId, stage) => { confirmations.push(stage); return { planId, stage, targetToken: 'source', token: stage }; }, start: async () => { starts++; return { operationId: 'op' }; } };
  const now = () => clock;
  const b = mount(() => useCatalogueTrash({ ficheId: 'card' }, { id: 'e' }, { filesApi, dataApi: { getCard: async () => ({ catalogueRevision: 1 }) }, now }));
  await b.hook.preview(); b.render();
  await b.hook.confirm(); await b.hook.confirm();
  assert.deepEqual(confirmations, []); assert.equal(starts, 0);
  b.render(); await b.hook.confirm(); assert.equal(starts, 0);
  clock = 399; await b.hook.confirm(); assert.equal(starts, 0);
  clock = 400; await b.hook.confirm(); await b.hook.confirm(); assert.deepEqual(confirmations, ['targets', 'irreversible']); assert.equal(starts, 1);
  b.app.unmount();
});
for (const kind of ['import', 'backup']) test(`${kind} expiry releases modal busy state`, async () => {
  let polls = 0;
  const api = { importOperation: async () => { polls++; throw expired; }, operation: async () => { polls++; throw expired; } };
  const b = mount(() => kind === 'import' ? useCatalogueImport({ api }) : useCatalogueBackup(1, { api }));
  b.hook.dispatch({ type: 'receipt', receipt: { operationId: 'op' } });
  if (kind === 'backup') b.hook.dispatch({ type: 'started', receipt: { operationId: 'op' } });
  else { b.hook.dispatch({ type: 'begin', mode: 'preview' }); b.hook.dispatch({ type: 'receipt', receipt: { operationId: 'op' } }); }
  b.render(); await tick(); b.render(); assert.equal(b.hook.state.phase, 'failed'); assert.equal(polls, 1); b.app.unmount();
});
test('mutation failure remains available inside the modal and resets on retry', async () => {
  let reject = true; let finish;
  const api = { mutate: async () => { if (reject) throw expired; return new Promise(resolve => { finish = resolve; }); } };
  const b = mount(() => useCatalogueSelectionActions({ ids: [], cards: [], visibleIds: [], revision: 1, api }));
  assert.equal(await b.hook.mutate({ kind: 'test' }), false); b.render(); assert.equal(b.hook.error, expired);
  reject = false; const pending = b.hook.mutate({ kind: 'test' }); b.render(); assert.equal(b.hook.error, null); finish({ affectedCardIds: [] }); await pending; b.app.unmount();
});
test('assembly closes even when cancellation fails', async () => {
  let resolve; const waiting = new Promise(r => { resolve = r; });
  const api = { prepare: async () => ({ operationId: 'op' }), cancel: async () => { throw expired; }, operation: async () => waiting };
  const b = mount(() => useCatalogueAssembly(api));
  const starting = b.hook.start([]); await tick(); b.render();
  await assert.rejects(b.hook.close()); b.render(); assert.equal(b.hook.state.phase, 'idle');
  resolve({ status: 'cancelled' }); await starting; b.app.unmount();
});
const { useCatalogueCard } = await import('../src/hooks/useCatalogueCard.js');
const { catalogueApi } = await import('../src/store/catalogue/catalogueApi.js');
const importFixture = (await import('./fixtures/catalogue/backup-import.json', { with: { type: 'json' } })).default;
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
test('trash preview reloads the revision for the same explicit exemplar', async () => {
  let targets;
  const api = { plan: async t => { targets = t; throw { code: 'CATALOG_REVISION_CONFLICT' }; } };
  const card = { ficheId: 'card', catalogueRevision: 4 };
  const b = mount(() => useCatalogueTrash(card, { id: 'e' }, { filesApi: api, dataApi: { getCard: async id => { assert.equal(id, 'card'); return { ficheId: 'card', catalogueRevision: 17 }; } } }));
  card.catalogueRevision = 99; b.render();
  await b.hook.preview(false);
  assert.equal(targets[0].expectedRevision, 17); assert.equal(targets[0].exemplarId, 'e'); b.app.unmount();
});
test('import double apply has a single request while paginated choices are pending', async () => {
  const page = importFixture.preview;
  const paging = deferred(); let applies = 0;
  const api = { importPage: async () => paging.promise, applyImport: async () => { applies++; return { operationId: 'apply' }; } };
  const b = mount(() => useCatalogueImport({ api }));
  b.hook.dispatch({ type: 'page', page, prepared: true }); b.render();
  const pending = b.hook.apply(); await b.hook.apply();
  paging.resolve(page); await pending; assert.equal(applies, 1); b.app.unmount();
});
test('fiche reloads coalesce scan events and discard a late response after changing fiche', async () => {
  const original = catalogueApi().subscribeChanges; const originalSet = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
  let notify; let timer; let calls = 0; const late = deferred(); let id = 'old';
  catalogueApi().subscribeChanges = cb => { notify = cb; return () => {}; };
  globalThis.setTimeout = cb => { timer = cb; return 1; }; globalThis.clearTimeout = () => { timer = null; };
  const api = { getCard: async ficheId => { calls++; return ficheId === 'old' && calls > 1 ? late.promise : { ficheId, catalogueRevision: ficheId === 'old' ? 0 : 9 }; } };
  let b;
  try {
    b = mount(() => useCatalogueCard(id, api)); await tick();
    for (let i = 0; i < 100; i++) notify({ revision: i });
    assert.equal(calls, 1); const run = timer; timer = null; run(); await tick(); assert.equal(calls, 2);
    id = 'new'; b.render(); await tick(); b.render(); assert.equal(b.hook.card.ficheId, 'new');
    late.resolve({ ficheId: 'old', catalogueRevision: 1 }); await tick(); b.render(); assert.equal(b.hook.card.ficheId, 'new');
  } finally { b?.app.unmount(); catalogueApi().subscribeChanges = original; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});
test('an opened fiche shows its card before the archive count, which never overrides a newer revision', async () => {
  const original = catalogueApi().subscribeChanges; let notify;
  catalogueApi().subscribeChanges = cb => { notify = cb; return () => {}; };
  const counts = []; const plain = []; let revision = 3;
  const counted = removal => ({ ficheId: 'card', catalogueRevision: revision, exemplars: [{ id: 'e', archiveRemoval: removal }] });
  const api = { getCard: async (ficheId, options) => {
    if (options?.inspectArchives) { const pending = deferred(); counts.push(pending); return pending.promise; }
    plain.push(ficheId); return { ficheId, catalogueRevision: revision, exemplars: [{ id: 'e', archiveRemoval: { enabled: true, reason: null, packCount: 1 } }] };
  } };
  let b;
  try {
    b = mount(() => useCatalogueCard('card', api, { inspectArchives: true })); await tick(); b.render();
    assert.equal(b.hook.card.catalogueRevision, 3); assert.equal(b.hook.archiveRemovals, null); assert.equal(counts.length, 1);
    // The catalogue changes while the count runs: its late answer is for revision 3.
    revision = 4; const answer = counted({ enabled: false, reason: 'multiple', packCount: 2 }); answer.catalogueRevision = 3;
    await b.hook.reload(); b.render(); assert.equal(b.hook.card.catalogueRevision, 4);
    assert.equal(counts.length, 1, 'one count at a time');
    counts[0].resolve(answer); await tick(); b.render();
    assert.equal(b.hook.archiveRemovals, null, 'a count for an older revision is not shown');
    assert.equal(counts.length, 2, 'the newer revision is counted in turn');
    counts[1].resolve(counted({ enabled: false, reason: 'multiple', packCount: 2 })); await tick(); b.render();
    assert.deepEqual(b.hook.archiveRemovals, { e: { enabled: false, reason: 'multiple', packCount: 2 } });
    assert.equal(b.hook.card.exemplars[0].archiveRemoval.enabled, true, 'the card itself is left untouched');
    b.app.unmount(); b = null;
    // Without the option (editing panel) the archives are never read.
    b = mount(() => useCatalogueCard('card', api)); await tick(); assert.equal(counts.length, 2); assert.equal(notify !== undefined, true);
  } finally { b?.app.unmount(); catalogueApi().subscribeChanges = original; }
});
test('trash expiry stops the first poll and reaches a terminal phase', async () => {
  const native = catalogueApi(); const originalGet = native.getOperation; const originalSet = globalThis.setTimeout; const originalClear = globalThis.clearTimeout;
  let polls = 0; let timers = 0;
  const operation = async () => { polls++; throw expired; };
  native.getOperation = operation; globalThis.setTimeout = () => { timers++; return 1; }; globalThis.clearTimeout = () => {};
  const api = { operation, release: async () => {}, cancel: async () => {}, plan: async () => ({ planId: 'p', action: 'trash', targets: [{ sourceToken: 'token' }] }), confirmRemoval: async () => ({ planId: 'p', stage: 'trash', targetToken: 'token', token: 'confirmation' }), start: async () => ({ operationId: 'op' }) };
  let b; let clock = 0;
  try {
    b = mount(() => useCatalogueTrash({ ficheId: 'c', catalogueRevision: 1 }, { id: 'e' }, { filesApi: api, dataApi: { getCard: async () => ({ catalogueRevision: 1 }) }, now: () => clock }));
    await b.hook.preview(); b.render(); clock = 400; await b.hook.confirm();
    b.render(); await tick(); b.render(); assert.equal(b.hook.state.phase, 'failed'); assert.equal(polls, 1); assert.equal(timers, 0);
  } finally { b?.app.unmount(); native.getOperation = originalGet; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; }
});

test('late plan arrival rearms 400ms and reset or unmount releases both held and late plans', async () => {
  let clock = 0; let stages = 0; let starts = 0; const released = [];
  const pending = deferred(); const plan = { planId: 'late', action: 'trash', targets: [{ sourceToken: 'source' }] };
  const api = { plan: () => pending.promise, releasePlan: async id => released.push(id), confirmRemoval: async () => { stages++; }, start: async () => { starts++; } };
  const now = () => clock;
  const b = mount(() => useCatalogueTrash({ id: 'c' }, { id: 'e' }, { filesApi: api, dataApi: { getCard: async () => ({ id: 'c' }) }, now }));
  const preview = b.hook.preview(); clock = 1000; pending.resolve(plan); await preview; b.render();
  clock = 1001; await b.hook.confirm(); assert.equal(stages, 0); assert.equal(starts, 0);
  b.hook.reset(); b.render(); assert.deepEqual(released, ['late']);
  await b.hook.preview(); b.render(); b.app.unmount(); assert.deepEqual(released, ['late', 'late']);
});
for (const changed of [false, true]) test(`revision conflict replans once and ${changed ? 'refuses changed bytes' : 'continues the same source'}`, async () => {
  let clock = 0; let plans = 0; let starts = 0; const released = [];
  const filesApi = {
    plan: async () => ({ planId: `p${++plans}`, action: 'trash', targets: [{ sourceToken: plans > 1 && changed ? 'changed' : 'same' }] }),
    releasePlan: async id => released.push(id),
    confirmRemoval: async (planId, stage) => { if (planId === 'p1') throw { code: 'CATALOG_REVISION_CONFLICT' }; return { planId, stage, targetToken: 'same', token: stage }; },
    start: async () => { starts++; return { operationId: 'op' }; },
  };
  const now = () => clock;
  const b = mount(() => useCatalogueTrash({ id: 'c' }, { id: 'e' }, { filesApi, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: plans }) }, now }));
  await b.hook.preview(); b.render(); clock = 400; await b.hook.confirm(); b.render();
  assert.equal(plans, 2); assert.equal(starts, changed ? 0 : 1);
  if (changed) assert.equal(b.hook.state.error.code, 'CATALOG_FILE_SOURCE_CHANGED');
  assert.ok(released.includes(changed ? 'p2' : 'p1')); b.app.unmount();
});

test('unmount during planning releases the late native plan without publishing review', async () => {
  const pending = deferred(); const released = [];
  const filesApi = { plan: () => pending.promise, releasePlan: async id => released.push(id) };
  const b = mount(() => useCatalogueTrash({ id: 'c' }, { id: 'e' }, { filesApi, dataApi: { getCard: async () => ({ id: 'c' }) } }));
  const preview = b.hook.preview(); await tick(); b.app.unmount();
  pending.resolve({ planId: 'after-unmount' }); await preview;
  assert.deepEqual(released, ['after-unmount']);
});

for (const conflictAt of ['confirmRemoval', 'start']) test(`unavailable trash then permanent revision conflict at ${conflictAt} replans and reconfirms without another gesture`, async () => {
  let clock = 0; let plans = 0; let starts = 0; let conflict = true; const stages = []; const prepared = []; const released = [];
  const filesApi = {
    plan: async () => ({ planId: `trash${++plans}`, action: 'trash', targets: [{ sourceToken: 'same' }] }),
    releasePlan: async id => released.push(id),
    preparePermanentDelete: async id => { prepared.push(id); return { planId: `permanent${plans}`, action: 'deletePermanently', targets: [{ sourceToken: 'same' }] }; },
    confirmRemoval: async (planId, stage, previous) => {
      stages.push([planId, stage, previous]);
      if (planId === 'permanent1' && conflictAt === 'confirmRemoval' && stage === 'irreversible' && conflict) { conflict = false; throw { code: 'CATALOG_REVISION_CONFLICT' }; }
      return { planId, stage, targetToken: 'same', token: `${planId}-${stage}` };
    },
    start: async (planId, decisions) => {
      starts++;
      if (planId === 'permanent1' && conflictAt === 'start' && conflict) { conflict = false; throw { code: 'CATALOG_REVISION_CONFLICT' }; }
      if (planId.startsWith('permanent')) assert.deepEqual(decisions.removalConfirmations, [`${planId}-targets`, `${planId}-irreversible`]);
      return { operationId: planId };
    },
  };
  const operationApi = () => ({ getOperation: async id => id === 'trash1' ? { status: 'failed', error: { code: 'CATALOG_TRASH_UNAVAILABLE' } } : { status: 'success' } });
  const b = mount(() => useCatalogueTrash({ id: 'c' }, { id: 'e' }, { filesApi, dataApi: { getCard: async () => ({ id: 'c', catalogueRevision: plans }) }, operationApi, now: () => clock }));
  await b.hook.preview(); b.render(); clock = 400;
  await b.hook.confirm(); b.render(); await tick(); b.render();
  assert.equal(b.hook.state.permanentPending, true);
  clock = 800; await b.hook.confirm(); b.render(); await tick(); b.render();
  assert.equal(b.hook.state.phase, 'finished');
  assert.deepEqual(prepared, ['trash1', 'trash2']);
  assert.deepEqual(stages.filter(([id]) => id === 'permanent2'), [['permanent2', 'targets', null], ['permanent2', 'irreversible', 'permanent2-targets']]);
  assert.equal(starts, conflictAt === 'start' ? 3 : 2);
  assert.ok(released.includes('permanent1'));
  b.app.unmount();
});
