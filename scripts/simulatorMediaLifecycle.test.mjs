import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMediaRequestKey,
  createMediaRequestLifecycle,
} from '../src/tabs/EmulatorTab/mediaRequestLifecycle.js';

function controlledPromise() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, reject, resolve };
}

function createHarness() {
  const pending = new Map();
  const applied = [];
  const discarded = [];
  const errors = [];
  let current = null;
  const lifecycle = createMediaRequestLifecycle({
    clearCurrent() { current = null; },
    load(input) {
      const deferred = controlledPromise();
      pending.set(input, deferred);
      return deferred.promise;
    },
    createResource(value) { return { value, destroyed: false }; },
    applyResource(resource) { current = resource; applied.push(resource.value); },
    discardResource(resource) { resource.destroyed = true; discarded.push(resource.value); },
    onError(error) { errors.push(error.message); },
  });
  return { applied, discarded, errors, lifecycle, pending, readCurrent: () => current };
}

test('audio A puis stage muet invalide A avant sa résolution', async () => {
  const harness = createHarness();
  const requestA = harness.lifecycle.request('A');
  const mute = harness.lifecycle.request(null);
  harness.pending.get('A').resolve('audio-A');
  assert.equal(await requestA, 'obsolete');
  assert.equal(await mute, 'empty');
  assert.deepEqual(harness.applied, []);
  assert.equal(harness.readCurrent(), null);
});

test('résolutions B puis A: seule la ressource B est appliquée', async () => {
  const harness = createHarness();
  const requestA = harness.lifecycle.request('A');
  const requestB = harness.lifecycle.request('B');
  harness.pending.get('B').resolve('media-B');
  assert.equal(await requestB, 'applied');
  harness.pending.get('A').resolve('media-A');
  assert.equal(await requestA, 'obsolete');
  assert.deepEqual(harness.applied, ['media-B']);
});

test('une nouvelle image efface immédiatement la précédente puis reste neutre sur erreur', async () => {
  const harness = createHarness();
  const first = harness.lifecycle.request('A');
  harness.pending.get('A').resolve('image-A');
  await first;
  assert.equal(harness.readCurrent().value, 'image-A');

  const second = harness.lifecycle.request('B');
  assert.equal(harness.readCurrent(), null);
  harness.pending.get('B').reject(new Error('missing'));
  assert.equal(await second, 'error');
  assert.equal(harness.readCurrent(), null);
  assert.deepEqual(harness.errors, ['missing']);
});

test('démontage et erreur obsolète ne produisent aucun effet utilisateur', async () => {
  const harness = createHarness();
  const request = harness.lifecycle.request('A');
  harness.lifecycle.invalidate({ clear: false });
  harness.pending.get('A').reject(new Error('late'));
  assert.equal(await request, 'obsolete');
  assert.deepEqual(harness.errors, []);
  assert.deepEqual(harness.applied, []);
});

test('une ressource créée puis invalidée est détruite avant application', async () => {
  const created = controlledPromise();
  const discarded = [];
  const applied = [];
  const lifecycle = createMediaRequestLifecycle({
    clearCurrent() {},
    async load() { return 'bytes'; },
    createResource() { return created.promise; },
    applyResource(resource) { applied.push(resource); },
    discardResource(resource) { discarded.push(resource); },
  });
  const request = lifecycle.request('A');
  await Promise.resolve();
  lifecycle.invalidate({ clear: false });
  created.resolve('late-player');
  assert.equal(await request, 'obsolete');
  assert.deepEqual(applied, []);
  assert.deepEqual(discarded, ['late-player']);
});

test('100 interleavings inversés ne laissent appliquer que la dernière requête', async () => {
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const harness = createHarness();
    const first = harness.lifecycle.request(`old-${iteration}`);
    const latest = harness.lifecycle.request(`new-${iteration}`);
    harness.pending.get(`new-${iteration}`).resolve(`new-${iteration}`);
    await latest;
    harness.pending.get(`old-${iteration}`).resolve(`old-${iteration}`);
    await first;
    assert.deepEqual(harness.applied, [`new-${iteration}`]);
  }
});

test('deux écrans qui partagent le même audio gardent des clés de lecture distinctes', () => {
  const request = { kind: 'local', path: 'C:/media/shared.mp3' };
  const cover = createMediaRequestKey(request, ['cover', 'root', null, 0]);
  const menu = createMediaRequestKey(request, ['browse', 'menu-1', null, 0]);
  assert.notEqual(cover, menu);
  assert.equal(
    createMediaRequestKey({ ...request }, ['cover', 'root', null, 0]),
    cover,
    'un simple changement de référence objet ne doit pas relancer la lecture',
  );
});
