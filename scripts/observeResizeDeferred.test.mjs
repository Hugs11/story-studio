import test from 'node:test';
import assert from 'node:assert/strict';
import { observeResizeDeferred } from '../src/hooks/observeResizeDeferred.js';

function env(run) {
  const saved = ['ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].map(n => [n, globalThis[n]]);
  const frames = new Map(); let id = 0; let deliver; let disconnected = 0;
  globalThis.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = n => { frames.delete(n); };
  globalThis.ResizeObserver = class { constructor(cb) { deliver = cb; } observe() {} disconnect() { disconnected++; } };
  try { run({ deliver: () => deliver(), frames, disconnected: () => disconnected }); }
  finally { for (const [n, v] of saved) v === undefined ? delete globalThis[n] : globalThis[n] = v; }
}

test('measure runs on a frame, never inside the observer delivery, and bursts coalesce', () => env(({ deliver, frames }) => {
  let calls = 0;
  observeResizeDeferred([{}], () => calls++);
  deliver(); deliver();
  assert.equal(calls, 0);
  assert.equal(frames.size, 1);
  [...frames.values()][0]();
  assert.equal(calls, 1);
}));

test('cleanup cancels the pending frame and disconnects', () => env(({ deliver, frames, disconnected }) => {
  let calls = 0;
  const stop = observeResizeDeferred([{}], () => calls++);
  deliver(); stop();
  assert.equal(frames.size, 0);
  assert.equal(disconnected(), 1);
  assert.equal(calls, 0);
}));
