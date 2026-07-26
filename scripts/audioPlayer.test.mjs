import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SharedAudioPlayer } from '../src/utils/audioPlayer.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

class FakeBackend {
  constructor() {
    this.listeners = new Map();
    this.paused = true;
    this.currentTime = 0;
    this.duration = 12;
    this.volume = 1;
    this.muted = false;
    this.playbackRate = 1;
    this.audioContext = { state: 'running' };
    this.gainNode = { disconnect() {} };
    this._src = '';
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener);
  }

  emit(type) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }

  set src(value) {
    this._src = value;
  }

  get src() {
    return this._src;
  }

  async play() {
    this.paused = false;
    this.emit('play');
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit('pause');
  }

  getGainNode() {
    return this.gainNode;
  }
}

test('shared audio player waits for WebAudio decoding before playback', async () => {
  const backend = new FakeBackend();
  const player = new SharedAudioPlayer('/tmp/Été sonore.FLAC', {
    createBackend: () => backend,
    loadTimeoutMs: 1_000,
  });

  const playPromise = player.play();
  assert.equal(backend.paused, true);
  backend.emit('loadedmetadata');
  await playPromise;

  assert.equal(backend.paused, false);
  assert.equal(player.duration, 12);
  player.destroy();
});

test('pause cancels playback requested while decoding', async () => {
  const backend = new FakeBackend();
  const player = new SharedAudioPlayer('D:\\Projet Test\\AUDIO.flac', {
    createBackend: () => backend,
    loadTimeoutMs: 1_000,
  });

  const playPromise = player.play();
  player.pause();
  backend.emit('loadedmetadata');
  await playPromise;

  assert.equal(backend.paused, true);
  player.destroy();
});

test('application playback stays on the shared WebAudio player', async () => {
  const files = await sourceFiles(path.join(projectRoot, 'src'));
  const offenders = [];

  await Promise.all(files.map(async (file) => {
    const source = await readFile(file, 'utf8');
    if (/\bnew\s+Audio\s*\(|<audio\b/i.test(source)) {
      offenders.push(path.relative(projectRoot, file));
    }
  }));

  assert.deepEqual(offenders.sort(), []);
});
