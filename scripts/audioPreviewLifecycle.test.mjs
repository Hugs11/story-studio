import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioPreviewLifecycle } from '../src/components/AudioEditorModal/audioPreviewLifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const applied = [];
  const discarded = [];
  const pending = [];
  const errors = [];
  const lifecycle = createAudioPreviewLifecycle({
    discardResult: async (path) => { discarded.push(path); },
    onPendingChange: (value) => { pending.push(value); },
    onError: (error) => { errors.push(String(error)); },
    ...overrides,
  });
  const task = (promise) => ({
    produce: () => promise,
    apply: (path) => { applied.push(path); },
  });
  return { lifecycle, task, applied, discarded, pending, errors };
}

test('audio preview lifecycle applies only the latest request when resolutions are reversed', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createHarness();

  const firstRun = harness.lifecycle.run(harness.task(first.promise));
  const secondRun = harness.lifecycle.run(harness.task(second.promise));
  second.resolve('preview-2.wav');
  assert.equal((await secondRun).status, 'applied');
  first.resolve('preview-1.wav');
  assert.equal((await firstRun).status, 'stale');

  assert.deepEqual(harness.applied, ['preview-2.wav']);
  assert.deepEqual(harness.discarded, ['preview-1.wav']);
});

test('audio preview lifecycle cleans an obsolete result without changing applied state', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createHarness();

  const firstRun = harness.lifecycle.run(harness.task(first.promise));
  const secondRun = harness.lifecycle.run(harness.task(second.promise));
  first.resolve('obsolete.wav');
  assert.equal((await firstRun).status, 'stale');
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(harness.discarded, ['obsolete.wav']);

  second.resolve('current.wav');
  await secondRun;
  assert.deepEqual(harness.applied, ['current.wav']);
});

test('audio preview lifecycle discards a late result after disposal', async () => {
  const request = deferred();
  const harness = createHarness();
  const run = harness.lifecycle.run(harness.task(request.promise));

  harness.lifecycle.dispose();
  request.resolve('late.wav');
  assert.equal((await run).status, 'stale');
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(harness.discarded, ['late.wav']);
  assert.deepEqual(harness.pending, [true]);
});

test('audio preview lifecycle debounce replaces the previous timer', async () => {
  let nextTimerId = 1;
  const timers = new Map();
  const harness = createHarness({
    setTimer: (callback) => {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
  });
  const first = deferred();
  const second = deferred();

  harness.lifecycle.debounce(harness.task(first.promise), 200);
  harness.lifecycle.debounce(harness.task(second.promise), 200);
  assert.equal(timers.size, 1);
  const [callback] = timers.values();
  callback();
  second.resolve('debounced.wav');
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(harness.applied, ['debounced.wav']);
  assert.deepEqual(harness.discarded, []);
});

test('audio preview lifecycle invalidation cancels timers and running requests', async () => {
  let timerCallback = null;
  const request = deferred();
  const harness = createHarness({
    setTimer: (callback) => {
      timerCallback = callback;
      return 1;
    },
    clearTimer: () => { timerCallback = null; },
  });

  harness.lifecycle.debounce(harness.task(Promise.resolve('never.wav')), 200);
  harness.lifecycle.invalidate();
  assert.equal(timerCallback, null);

  const run = harness.lifecycle.run(harness.task(request.promise));
  harness.lifecycle.invalidate();
  request.resolve('cancelled.wav');
  assert.equal((await run).status, 'stale');
  assert.deepEqual(harness.applied, []);
  assert.deepEqual(harness.discarded, ['cancelled.wav']);
});

test('audio preview lifecycle lets only the latest request release pending state', async () => {
  const first = deferred();
  const second = deferred();
  const harness = createHarness();

  const firstRun = harness.lifecycle.run(harness.task(first.promise));
  const secondRun = harness.lifecycle.run(harness.task(second.promise));
  first.resolve('old.wav');
  await firstRun;
  assert.deepEqual(harness.pending, [true]);

  second.resolve('new.wav');
  await secondRun;
  assert.deepEqual(harness.pending, [true, false]);
});

test('audio preview lifecycle reports the latest failure and allows retry', async () => {
  const failed = deferred();
  const retry = deferred();
  const harness = createHarness();

  const failedRun = harness.lifecycle.run(harness.task(failed.promise));
  failed.reject(new Error('ffmpeg failed'));
  assert.equal((await failedRun).status, 'error');
  assert.deepEqual(harness.errors, ['Error: ffmpeg failed']);
  assert.deepEqual(harness.pending, [true, false]);

  const retryRun = harness.lifecycle.run(harness.task(retry.promise));
  retry.resolve('retry.wav');
  assert.equal((await retryRun).status, 'applied');
  assert.deepEqual(harness.applied, ['retry.wav']);
  assert.deepEqual(harness.pending, [true, false, true, false]);
});
