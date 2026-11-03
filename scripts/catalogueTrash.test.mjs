import test from 'node:test';
import assert from 'node:assert/strict';
import fixture from './fixtures/catalogue/removal-confirmation.json' with { type: 'json' };
import planFixture from './fixtures/catalogue/file-plan.json' with { type: 'json' };
import { acceptRemovalConfirmation, removalStage, trashAvailability, launchRemoval } from '../src/store/catalogue/trashPlan.js';
import { createCatalogueFilesApi } from '../src/store/catalogue/catalogueFilesApi.js';
import { exemplarActions } from '../src/store/catalogue/cardActions.js';
const plan = { ...planFixture, planId: fixture.planId, action: 'deletePermanently', targets: [{ ...planFixture.targets[0], sourceToken: fixture.targetToken }] };
test('two ordered receipts are bound to the exact plan and strong target token', () => {
  assert.equal(removalStage(plan, []), 'targets');
  const first = acceptRemovalConfirmation(plan, [], fixture);
  assert.equal(removalStage(plan, first), 'irreversible');
  const second = { ...fixture, stage: 'irreversible', token: 'second-receipt' };
  assert.equal(removalStage(plan, acceptRemovalConfirmation(plan, first, second)), null);
  for (const changed of [{ planId: 'other' }, { targetToken: 'changed' }, { stage: 'irreversible' }]) assert.throws(() => acceptRemovalConfirmation(plan, [], { ...fixture, ...changed }));
  assert.throws(() => acceptRemovalConfirmation(plan, first, { ...second, token: fixture.token }));
  assert.equal(removalStage({ ...plan, action: 'trash' }, []), 'trash');
  assert.equal(removalStage({ ...plan, targets: [...plan.targets, ...plan.targets] }, []), null);
});
test('one gesture starts only after all target-bound receipts; refusals discard the local receipt chain', async () => {
  const calls = []; let rejectSecond = true;
  const api = {
    confirmRemoval: async (planId, stage, previous) => {
      calls.push({ stage, previous });
      if (stage === 'irreversible' && rejectSecond) throw { code: 'CATALOG_FILE_SOURCE_CHANGED' };
      return { ...fixture, planId, stage, token: stage };
    },
    start: async (...args) => { calls.push({ start: args }); return { operationId: 'op' }; },
  };
  await assert.rejects(launchRemoval(api, plan, 'first'), error => error.code === 'CATALOG_FILE_SOURCE_CHANGED');
  assert.deepEqual(calls, [{ stage: 'targets', previous: null }, { stage: 'irreversible', previous: 'targets' }]);
  rejectSecond = false; calls.length = 0;
  await launchRemoval(api, plan, 'retry');
  assert.deepEqual(calls[0], { stage: 'targets', previous: null });
  assert.deepEqual(calls[2].start, [plan.planId, { summaryValidated: true, skipExemplarIds: [], removalConfirmations: ['targets', 'irreversible'] }, 'retry']);
  let started = false;
  await assert.rejects(launchRemoval({ confirmRemoval: async () => ({ ...fixture, targetToken: 'foreign-target' }), start: async () => { started = true; } }, plan, 'wrong'));
  assert.equal(started, false);
});
test('trash command is single exemplar and eligible for projects and disabled for leased projects, children and unavailable targets', () => {
  for (const format of ['zip', '7z', 'studioDirectory', 'fsDirectory', 'project']) {
    const exemplar = { id: 'pack', format, state: 'available', path: '/packs/pack.zip' };
    assert.equal(trashAvailability(exemplar).enabled, true);
    assert.equal(exemplarActions({}, exemplar).find(a => a.id === 'trash').enabled, true);
    for (const changed of [{ projectInUse: true }, { member: 'child.zip' }, { available: false }, { state: 'missing' }]) {
      const action = exemplarActions({}, { ...exemplar, ...changed }).find(a => a.id === 'trash');
      assert.equal(action.enabled, false); assert.equal(action.reasonKey, 'catalogue:actions.reason.noExemplar');
    }
  }
});
test('manual confirmation DTO, exact native IPC arguments and typed refusals', async () => {
  const calls = [];
  const api = createCatalogueFilesApi({ invoke: async (command, args) => { calls.push({ command, args }); return command === 'catalogue_confirm_file_removal' ? fixture : plan; } });
  assert.deepEqual(await api.confirmRemoval(plan.planId, 'targets'), fixture);
  assert.deepEqual(calls[0], { command: 'catalogue_confirm_file_removal', args: { planId: plan.planId, stage: 'targets', previousToken: null } });
  assert.deepEqual(await api.preparePermanentDelete('trash-plan'), plan);
  assert.deepEqual(calls[1], { command: 'catalogue_prepare_permanent_delete', args: { trashPlanId: 'trash-plan' } });
  const failing = createCatalogueFilesApi({ invoke: async () => { throw { code: 'CATALOG_DELETE_CONFIRMATION_REQUIRED', params: {} }; } });
  await assert.rejects(failing.confirmRemoval('plan', 'irreversible'), e => e.code === 'CATALOG_DELETE_CONFIRMATION_REQUIRED');
});

test('archive availability displays the Rust decision without recomputing the pack rule', () => {
  const exemplar = { member: 'pack', state: 'available' };
  assert.equal(trashAvailability({ ...exemplar, archiveRemoval: { enabled: true, packCount: 2 } }).enabled, true);
  assert.equal(trashAvailability({ ...exemplar, archiveRemoval: { enabled: false, reason: 'unavailable', packCount: 1 } }).enabled, false);
  // An unknown reason falls back to an explicit text, never `t(null)`.
  for (const reason of ['mystery', null, undefined, 'toString']) {
    assert.deepEqual(trashAvailability({ ...exemplar, archiveRemoval: { enabled: false, reason, packCount: null } }), { enabled: false, reasonKey: 'catalogue:trash.archiveRefused', reasonParams: {} });
  }
  assert.deepEqual(trashAvailability({ ...exemplar, archiveRemoval: { enabled: false, reason: 'multiple', packCount: 2 } }), { enabled: false, reasonKey: 'catalogue:trash.archiveShared', reasonParams: { count: 2 } });
  // A direct archive is only refused by the engine; otherwise the ordinary rules apply.
  const direct = { format: 'zip', state: 'available' };
  assert.equal(trashAvailability({ ...direct, archiveRemoval: null }).enabled, true);
  assert.equal(trashAvailability({ ...direct, archiveRemoval: { enabled: false, reason: 'multiple', packCount: 2 } }).reasonKey, 'catalogue:trash.archiveShared');
});
