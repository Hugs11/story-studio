import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEditPackOperationLifecycle,
  runEditPackImportOperation,
} from '../src/components/EditPack/editPackOperationLifecycle.js';

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, reject, resolve };
}

test('un démontage pendant conversion interdit classification et atterrissage', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const token = lifecycle.begin();
  lifecycle.invalidate();
  assert.equal(lifecycle.isCurrent(token), false);
  assert.equal(lifecycle.claimCompletion(token), false);
});

test('une invalidation pendant classification interdit onLand', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const token = lifecycle.begin();
  assert.equal(lifecycle.isCurrent(token), true);
  lifecycle.invalidate();
  assert.equal(lifecycle.claimCompletion(token), false);
});

test('double lancement refusé et succès courant réclamé une seule fois', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const token = lifecycle.begin();
  assert.equal(lifecycle.begin(), null);
  assert.equal(lifecycle.claimCompletion(token), true);
  assert.equal(lifecycle.claimCompletion(token), false);
  assert.equal(lifecycle.finish(token), true);
  assert.equal(lifecycle.isRunning(), false);
});

test('une nouvelle ouverture ne reconnaît aucun jeton antérieur', () => {
  const lifecycle = createEditPackOperationLifecycle();
  const oldToken = lifecycle.begin();
  lifecycle.invalidate();
  const nextToken = lifecycle.begin();
  assert.notEqual(nextToken, oldToken);
  assert.equal(lifecycle.isCurrent(oldToken), false);
  assert.equal(lifecycle.isCurrent(nextToken), true);
});

test('démontage pendant conversion: classification et onLand ne sont jamais appelés', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const conversion = controlledPromise();
  let classifications = 0;
  let landings = 0;
  const running = runEditPackImportOperation({
    lifecycle,
    path: 'pack-folder',
    isFolder: true,
    convertFolder: () => conversion.promise,
    classify: async () => { classifications += 1; return { authoringEditable: true }; },
    land: async () => { landings += 1; },
  });
  lifecycle.invalidate();
  conversion.resolve('pack.zip');
  assert.deepEqual(await running, { status: 'cancelled' });
  assert.equal(classifications, 0);
  assert.equal(landings, 0);
});

test('démontage pendant classification: onLand reste interdit', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  const classification = controlledPromise();
  let landings = 0;
  const running = runEditPackImportOperation({
    lifecycle,
    path: 'pack.zip',
    isFolder: false,
    convertFolder: async () => assert.fail('conversion should not run'),
    classify: () => classification.promise,
    land: async () => { landings += 1; },
  });
  await Promise.resolve();
  lifecycle.invalidate();
  classification.resolve({ authoringEditable: true });
  assert.deepEqual(await running, { status: 'cancelled' });
  assert.equal(landings, 0);
});

test('succès normal appelle onLand exactement une fois', async () => {
  const lifecycle = createEditPackOperationLifecycle();
  let landings = 0;
  const result = await runEditPackImportOperation({
    lifecycle,
    path: 'pack.zip',
    isFolder: false,
    convertFolder: async () => assert.fail('conversion should not run'),
    classify: async () => ({ authoringEditable: true }),
    land: async () => { landings += 1; },
  });
  assert.equal(result.status, 'landed');
  assert.equal(landings, 1);
  assert.equal(lifecycle.isRunning(), false);
});
