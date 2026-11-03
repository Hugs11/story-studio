import test from 'node:test';
import assert from 'node:assert/strict';
import WebAudioPlayer from 'wavesurfer.js/dist/webaudio.js';
import { SharedAudioPlayer } from '../src/utils/audioPlayer.js';

// Même backend que l'application ; seule l'horloge et les nœuds natifs sont
// simulés. Le cas 44101/44100 vient de la reproduction de l'incident.
function fixture(t, start = 10.01, duration = 44101 / 44100) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const context = {
    currentTime: start, state: 'running', destination: {},
    createGain: () => ({ connect() {}, disconnect() {}, gain: { value: 1 } }),
    createBufferSource: () => ({
      playbackRate: { value: 1 }, connect() {}, disconnect() {}, start() {}, stop() {}, onended: null,
    }),
  };
  const backend = new WebAudioPlayer(context);
  backend.buffer = { duration };
  const player = new SharedAudioPlayer('', { createBackend: () => backend });
  const events = [];
  for (const type of ['play', 'pause', 'ended']) player.addEventListener(type, () => events.push(type));
  t.after(() => player.destroy());
  return { context, backend, player, events, start, duration };
}

test('fin native filtrée à durée - epsilon : rattrapage sans anticipation et une seule fin', async (t) => {
  const { context, backend, player, events, start, duration } = fixture(t);
  await backend.play();
  context.currentTime = start + duration;
  assert.ok(player.currentTime < duration);
  const nativeEnd = backend.bufferNode.onended;
  nativeEnd();
  t.mock.timers.tick(100);
  assert.deepEqual(events, ['play']);
  assert.equal(player.ended, false);
  // WaveSurfer laisse bien son horloge avancer après la fin du buffer.
  context.currentTime += 0.1;
  assert.ok(player.currentTime > duration);
  t.mock.timers.tick(100);
  assert.equal(player.ended, true);
  assert.equal(player.paused, true);
  nativeEnd();
  t.mock.timers.tick(1000);
  assert.deepEqual(events, ['play', 'pause', 'ended']);
});

for (const [start, duration] of [[0, 1], [10.01, 44101 / 44100], [123.45, 30.5]]) {
  test(`fin nominale non dupliquée (${start}, ${duration}), puis relecture`, async (t) => {
    const f = fixture(t, start, duration);
    await f.backend.play();
    f.context.currentTime += duration + 0.01;
    f.backend.bufferNode.onended();
    t.mock.timers.tick(500);
    assert.deepEqual(f.events, ['play', 'pause', 'ended']);
    await f.backend.play();
    f.context.currentTime += duration + 0.01;
    t.mock.timers.tick(100);
    assert.deepEqual(f.events, ['play', 'pause', 'ended', 'play', 'pause', 'ended']);
  });
}

for (const action of ['pause', 'seek arrière', 'seek avant', 'source', 'destroy']) {
  test(`${action} après une notification filtrée : aucune fausse fin`, async (t) => {
    const { context, backend, player, events, start, duration } = fixture(t);
    await backend.play();
    context.currentTime = start + duration;
    backend.bufferNode.onended();
    if (action === 'pause') player.pause();
    if (action === 'seek arrière') player.currentTime = 0.2;
    if (action === 'seek avant') player.currentTime = duration;
    if (action === 'source') {
      // Une URL nouvelle déclenche un chargement, sans réseau dans ce test.
      Object.defineProperty(backend, 'src', { set() {} });
      player.src = 'nouveau-son';
    }
    if (action === 'destroy') player.destroy();
    context.currentTime += 0.1;
    t.mock.timers.tick(100);
    assert.equal(events.filter((e) => e === 'ended').length, 0);
    assert.equal(player.ended, false);
  });
}

test('pause juste avant la fin et événement natif tardif : aucune fin', async (t) => {
  const { context, backend, player, events, start, duration } = fixture(t);
  await backend.play();
  const nativeEnd = backend.bufferNode.onended;
  context.currentTime = start + duration - 0.001;
  player.pause();
  context.currentTime += 1;
  nativeEnd();
  t.mock.timers.tick(1000);
  assert.deepEqual(events, ['play', 'pause']);
});

for (const action of ['source', 'destroy']) {
  test(`${action} avant la fin : notification de l'ancien buffer ignorée`, async (t) => {
    const { context, backend, player, events, start, duration } = fixture(t);
    await backend.play();
    const nativeEnd = backend.bufferNode.onended;
    context.currentTime = start + duration - 0.001;
    if (action === 'destroy') player.destroy();
    else {
      Object.defineProperty(backend, 'src', { set() {} });
      player.src = 'nouveau-son';
    }
    context.currentTime += 1;
    nativeEnd();
    t.mock.timers.tick(1000);
    assert.equal(events.filter((e) => e === 'ended').length, 0);
  });
}

test('seek en pause vers la durée : aucune fin synthétique', async (t) => {
  const { context, backend, player, events, duration } = fixture(t);
  await backend.play();
  player.pause();
  player.currentTime = duration;
  context.currentTime += 1;
  t.mock.timers.tick(1000);
  assert.deepEqual(events, ['play', 'pause']);
});

test('pause pendant la reprise du contexte suspendu : la lecture ne repart pas', async (t) => {
  const { context, backend, player, events } = fixture(t);
  Object.defineProperty(backend, 'src', { set() {} });
  player.src = 'son';
  backend.emit('loadedmetadata');
  let resumed;
  context.state = 'suspended';
  context.resume = () => new Promise((resolve) => { resumed = resolve; });
  const playing = player.play();
  await Promise.resolve();
  player.pause();
  resumed();
  await playing;
  assert.deepEqual(events, []);
  assert.equal(player.paused, true);
});
