import assert from 'node:assert/strict';
import test from 'node:test';
import { createAudioLevelApi, measureAudioLevel } from '../src/store/audioLevel.js';

test('audio level boundary forwards the exact path and report', async () => {
  const report = { integratedLufs: -50, truePeakDb: -47, notice: 'AUDIO_NEAR_MUTE_BOOST' };
  const api = createAudioLevelApi({ invoke: async (command, args) => {
    assert.equal(command, 'measure_audio_level');
    assert.deepEqual(args, { path: '/Media/Voix actuelle.wav' });
    return report;
  } });
  assert.equal(await api.measureAudioLevel('/Media/Voix actuelle.wav'), report);
  assert.equal(typeof measureAudioLevel, 'function');
});

test('audio level boundary preserves structured transport errors', async () => {
  const error = JSON.stringify({ code: 'FILES_ABSOLUTE_PATH_REQUIRED', params: { label: 'audio' } });
  const api = createAudioLevelApi({ invoke: async () => { throw error; } });
  await assert.rejects(api.measureAudioLevel('relative.wav'), reason => reason === error);
});

test('obsolete engine results are null, without a user-facing error', async () => {
  const api = createAudioLevelApi({ invoke: async () => null });
  assert.equal(await api.measureAudioLevel('/changed.wav'), null);
});

test('aborted queued requests never invoke measurement and the queue continues', async () => {
  const calls = [];
  const releases = [];
  const api = createAudioLevelApi({ invoke: (_command, { path }) => {
    calls.push(path);
    return new Promise(resolve => releases.push(resolve));
  } });
  const first = api.measureAudioLevel('/one.wav');
  const second = api.measureAudioLevel('/two.wav');
  const controller = new AbortController();
  const abandoned = api.measureAudioLevel('/obsolete.wav', { signal: controller.signal });
  const next = api.measureAudioLevel('/next.wav');
  const rejected = assert.rejects(abandoned, { name: 'AbortError' });
  controller.abort();
  await rejected;
  assert.deepEqual(calls, ['/one.wav', '/two.wav']);
  releases[0](null);
  await first;
  assert.deepEqual(calls, ['/one.wav', '/two.wav', '/next.wav']);
  releases[1](null);
  releases[2](null);
  await Promise.all([second, next]);
});

test('already aborted work does not invoke the engine', async () => {
  const api = createAudioLevelApi({ invoke: () => assert.fail('must not invoke') });
  await assert.rejects(api.measureAudioLevel('/obsolete.wav', { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('aborting started work does not release its concurrency slot prematurely', async () => {
  const releases = [];
  let calls = 0;
  const api = createAudioLevelApi({ invoke: () => {
    calls += 1;
    return new Promise(resolve => releases.push(resolve));
  } });
  const controller = new AbortController();
  const first = api.measureAudioLevel('/one', { signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = api.measureAudioLevel('/two');
  const third = api.measureAudioLevel('/three');
  controller.abort();
  await rejected;
  assert.equal(calls, 2);
  releases[0](null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  releases[1](null);
  releases[2](null);
  await Promise.all([second, third]);
});
