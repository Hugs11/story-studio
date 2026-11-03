import test from 'node:test';
import assert from 'node:assert/strict';
import { createDuplicateRequest } from '../src/store/catalogue/duplicateRequest.js';
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('cancellation before the first IPC receipt is delivered is retained', async () => {
  const pending = deferred(); const cancelled = [];
  const request = createDuplicateRequest({ find: () => pending.promise, cancel: async id => cancelled.push(id), onCancelError: assert.fail });
  const started = request.start({ ficheId: null }, 'first');
  await request.cancel(); await request.cancel();
  assert.deepEqual(cancelled, []);
  pending.resolve({ operationId: 'first-operation' });
  assert.deepEqual(await started, { operationId: 'first-operation' });
  assert.deepEqual(cancelled, ['first-operation']);
});
test('a relaunch resets the old receipt before awaiting the next IPC response', async () => {
  const pending = deferred(); const cancelled = []; let calls = 0;
  const request = createDuplicateRequest({ find: async () => ++calls === 1 ? { operationId: 'old' } : pending.promise, cancel: async id => cancelled.push(id), onCancelError: assert.fail });
  await request.start({}, 'first');
  const started = request.start({}, 'second');
  await request.cancel();
  assert.deepEqual(cancelled, []);
  pending.resolve({ operationId: 'new' }); await started;
  assert.deepEqual(cancelled, ['new']);
});
test('cancellation also survives awaiting release of the previous results', async () => {
  const release = deferred(); const cancelled = [];
  const request = createDuplicateRequest({ find: async () => { await release.promise; return { operationId: 'new' }; }, cancel: async id => cancelled.push(id), onCancelError: assert.fail });
  const started = request.start({}, 'new'); await request.cancel();
  assert.deepEqual(cancelled, []); release.resolve(); await started;
  assert.deepEqual(cancelled, ['new']);
});
test('finishing clears cancellation ownership and a failed cancellation can be retried', async () => {
  const errors = []; let attempts = 0;
  const request = createDuplicateRequest({ find: async () => ({ operationId: 'operation' }), cancel: async () => { attempts += 1; if (attempts === 1) throw new Error('unavailable'); }, onCancelError: error => errors.push(error.message) });
  await request.start({}, 'request');
  await assert.rejects(request.cancel(), /unavailable/);
  await request.cancel(); assert.equal(attempts, 2);
  request.finish('operation'); await request.cancel(); assert.equal(attempts, 2); assert.deepEqual(errors, []);
});
test('an early cancellation failure leaves the receipt available for tracking and retry', async () => {
  const pending = deferred(); const errors = []; let attempts = 0;
  const request = createDuplicateRequest({ find: () => pending.promise, cancel: async () => { if (++attempts === 1) throw new Error('retry'); }, onCancelError: error => errors.push(error.message) });
  const started = request.start({}, 'request'); await request.cancel(); pending.resolve({ operationId: 'operation' });
  assert.deepEqual(await started, { operationId: 'operation' }); assert.deepEqual(errors, ['retry']);
  await request.cancel(); assert.equal(attempts, 2);
});
