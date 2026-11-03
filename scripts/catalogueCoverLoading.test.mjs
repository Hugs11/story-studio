import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverLoading, initialCoverState, coverAttemptAddress, coverRetryDelay } from '../src/store/catalogue/coverLoading.js';

function clock() {
  let time = 0, id = 0;
  const tasks = new Map();
  return { tasks, now: () => time,
    schedule(fn, delay) { const key = ++id; tasks.set(key, { fn, at: time + delay }); return key; },
    cancel(key) { tasks.delete(key); },
    advance(delay) {
      const end = time + delay;
      while (true) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at).find(([, task]) => task.at <= end);
        if (!next) break;
        time = next[1].at; tasks.delete(next[0]); next[1].fn();
      }
      time = end;
    },
  };
}
const response = (kind, status = 503, retryAfter = null) => ({ status,
  headers: new Headers({ ...(kind ? { 'x-cover-state': kind } : {}), ...(retryAfter ? { 'Retry-After': retryAfter } : {}) }) });
let nextAddress = 0;
function setup(request = async () => { throw new Error('network'); }, address = `catalogue-cover://localhost/v1/a/hash-${nextAddress++}.jpg`) {
  const timers = clock(), changes = [], calls = [];
  const loader = createCoverLoading({ address, changed: state => changes.push(state), ...timers,
    request: (...args) => { calls.push(args); return request(...args); } });
  loader.start({ complete: false });
  return { loader, timers, changes, calls, address, state: () => changes.at(-1) ?? initialCoverState(address) };
}

test('silent until 1s; arrivals fade, cancel the label and never issue HEAD on success', () => {
  const app = setup();
  assert.equal(app.state().phase, 'waiting');
  app.timers.advance(999); assert.equal(app.state().phase, 'waiting');
  app.timers.advance(1); assert.equal(app.state().phase, 'loading');
  app.loader.loaded(); assert.deepEqual(app.state(), { phase: 'ready', attempt: 0, fade: true });
  app.timers.advance(10000); assert.equal(app.state().phase, 'ready');
  assert.equal(app.calls.length, 0); assert.equal(app.timers.tasks.size, 0);
});

test('cached complete image is ready without fading; broken complete image is diagnosed', async () => {
  const timers = clock(), changes = [];
  const app = createCoverLoading({ address: 'cached', changed: state => changes.push(state), ...timers });
  app.start({ complete: true, naturalWidth: 768 });
  assert.deepEqual(changes, [{ phase: 'ready', attempt: 0, fade: false }]);
  assert.equal(timers.tasks.size, 0);
  const broken = setup(async () => response('unreadable', 422));
  broken.loader.start({ complete: true, naturalWidth: 0 });
  await broken.loader.failed(); await Promise.resolve();
  assert.equal(broken.state().phase, 'unreadable');
  broken.loader.dispose();
});

for (const [kind, status, phase] of [
  ['absent', 204, 'absent'], ['unreadable', 422, 'unreadable'], ['tooLarge', 413, 'tooLarge'],
  ['stale', 410, 'stale'], [null, 410, 'stale'], [null, 404, 'absent'], [null, 400, 'unreadable'],
  ['offline', 503, 'offline'],
]) test(`HEAD ${kind}/${status} terminates as ${phase} without retry`, async () => {
  const app = setup(async () => response(kind, status));
  assert.equal(app.calls.length, 0);
  await app.loader.failed();
  assert.equal(app.state().phase, phase);
  assert.equal(app.timers.tasks.size, 0);
  app.timers.advance(60000); assert.equal(app.calls.length, 1);
  app.loader.loaded(); assert.equal(app.state().phase, phase);
  assert.equal(app.calls[0][0], app.address);
  const options = app.calls[0][1];
  assert.equal(options.method, 'HEAD'); assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers, undefined, 'no preflight-triggering headers');
});

for (const kind of ['busy', 'network']) test(`${kind} makes three total attempts, then stops; query changes on each attempt`, async () => {
  const app = setup(async () => { if (kind === 'network') throw new Error('offline'); return response(kind); });
  for (let attempt = 0; attempt < 3; attempt++) {
    await app.loader.failed();
    assert.equal(app.calls.at(-1)[0], coverAttemptAddress(app.address, attempt));
    if (attempt < 2) {
      app.timers.advance(1000 * 2 ** attempt - 1);
      assert.equal(app.state().attempt, attempt);
      app.timers.advance(1); assert.equal(app.state().attempt, attempt + 1);
      assert.equal(app.state().phase, 'loading', 'slow-loading label survives retries');
    }
  }
  assert.equal(app.state().phase, 'unreadable');
  await app.loader.failed(); app.timers.advance(100000);
  assert.equal(app.calls.length, 3); assert.equal(app.timers.tasks.size, 0);
});

test('Retry-After supports seconds and HTTP dates; a duplicate error does not bypass the delay', async () => {
  assert.equal(coverRetryDelay('5', 0, 0), 5000);
  assert.equal(coverRetryDelay('Thu, 01 Jan 1970 00:00:09 GMT', 0, 1000), 8000);
  assert.equal(coverRetryDelay('invalid', 2, 0), 4000);
  assert.equal(coverRetryDelay('-1', 0, 0), 1000);
  const app = setup(async () => response('busy', 503, '5'));
  await app.loader.failed(); await app.loader.failed(); assert.equal(app.calls.length, 1);
  app.timers.advance(4999); assert.equal(app.state().attempt, 0);
  app.timers.advance(1); assert.equal(app.state().attempt, 1);
  app.loader.loaded(); assert.equal(app.state().phase, 'ready');
  assert.equal(app.timers.tasks.size, 0);
});

test('network timeout is bounded and disposal aborts diagnostics and cancels all retries', async () => {
  const app = setup(() => new Promise(() => {}));
  const failed = app.loader.failed();
  app.timers.advance(5000); await failed;
  assert.equal(app.calls[0][1].signal.aborted, true);
  app.timers.advance(1000); assert.equal(app.state().attempt, 1);
  const pending = app.loader.failed();
  app.loader.dispose(); const count = app.changes.length;
  assert.equal(app.calls.at(-1)[1].signal.aborted, true);
  app.timers.advance(100000); assert.equal(app.changes.length, count);
  assert.equal(app.timers.tasks.size, 0);
  void pending;
});

test('late diagnostics from a replaced fiche cannot publish or schedule a retry', async () => {
  let finish;
  const app = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = app.loader.failed(); app.loader.dispose();
  finish(response('busy')); await pending;
  assert.equal(app.changes.length, 0); assert.equal(app.timers.tasks.size, 0);
});

test('without an address nothing is requested, timed or retried', async () => {
  const app = setup(undefined, null);
  await app.loader.failed(); app.loader.loaded();
  assert.equal(app.state().phase, 'absent');
  assert.equal(app.calls.length, 0); assert.equal(app.timers.tasks.size, 0);
});


test('HEAD ready retries immediately once, then a repeated decode failure is unreadable', async () => {
  const app = setup(async () => response('ready', 200));
  await app.loader.failed();
  assert.equal(app.state().phase, 'waiting');
  assert.equal(app.state().attempt, 1);
  assert.equal(coverAttemptAddress(app.address, app.state().attempt), `${app.address}?r=1`);
  await app.loader.failed();
  assert.equal(app.state().phase, 'unreadable');
  assert.equal(app.calls.length, 2);
  assert.equal(app.timers.tasks.size, 0);
});

test('busy then HEAD ready can succeed; immediate retry counts in the three-attempt bound', async () => {
  let kind = 'busy';
  const app = setup(async () => response(kind, kind === 'ready' ? 200 : 503));
  await app.loader.failed(); app.timers.advance(1000);
  kind = 'ready'; await app.loader.failed();
  assert.equal(app.state().attempt, 2);
  app.loader.loaded(); assert.equal(app.state().phase, 'ready');
  const exhausted = setup(async () => response(kind, kind === 'ready' ? 200 : 503));
  kind = 'busy';
  await exhausted.loader.failed(); exhausted.timers.advance(1000);
  await exhausted.loader.failed(); exhausted.timers.advance(2000);
  kind = 'ready'; await exhausted.loader.failed();
  assert.equal(exhausted.state().phase, 'unreadable');
  assert.equal(exhausted.state().attempt, 2);
});
