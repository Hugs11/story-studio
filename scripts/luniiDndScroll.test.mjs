// Separate file: needs the hook driver's React, which luniiDnd.test.mjs (real DOM render) cannot share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { useLuniiDnd } = await import('../src/hooks/useLuniiDnd.js');

test('auto-scroll follows the pointer near the list edge, stops at zero speed and cancels its frame', () => {
  const frames = new Map(); const cancelled = []; let next = 1;
  const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = fn => { frames.set(next, fn); return next++; };
  globalThis.cancelAnimationFrame = id => { cancelled.push(id); frames.delete(id); };
  const list = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100, bottom: 400 }) };
  const under = { closest: selector => (selector === '.lunii-scroll' ? list : null) };
  let y = 395;
  const lunii = { luniiDevices: [], send: { startDrag() {}, hover: () => false, leave() {}, endDrag() {} } };
  const app = runner(() => useLuniiDnd({ lunii, sendUi: { drag: { idsFor: id => [id] } }, onDeviceChange() {}, elementAt: () => under }));
  const run = () => { const [id, fn] = [...frames][0]; frames.delete(id); fn(); };
  try {
    const hook = () => app.render().handlers;
    hook().onDragStart({ active: { data: { current: { kind: 'card', cardId: 'x' } } } });
    const move = () => hook().onDragMove({ activatorEvent: { clientX: 10, clientY: y }, delta: { x: 0, y: 0 } });
    move(); assert.equal(frames.size, 1);
    run(); assert.ok(list.scrollTop > 0, 'scrolls near the bottom edge'); assert.equal(frames.size, 1, 'schedules the next frame');
    const before = list.scrollTop; run(); assert.ok(list.scrollTop > before);
    y = 250; move(); run();
    assert.equal(list.scrollTop > before, true); const stopped = list.scrollTop; assert.equal(frames.size, 0, 'zero speed ends the loop');
    assert.equal(list.scrollTop, stopped);
    y = 395; move(); assert.equal(frames.size, 1);
    hook().onDragEnd({ activatorEvent: { clientX: 10, clientY: 395 }, delta: { x: 0, y: 0 } });
    assert.equal(frames.size, 0); assert.equal(cancelled.length, 1, 'end cancels the pending frame');
    hook().onDragStart({ active: { data: { current: { kind: 'card', cardId: 'x' } } } }); move(); assert.equal(frames.size, 1);
    hook().onDragCancel();
    assert.equal(frames.size, 0); assert.equal(cancelled.length, 2, 'cancel cancels the pending frame');
  } finally {
    app.unmount();
    globalThis.requestAnimationFrame = saved.raf; globalThis.cancelAnimationFrame = saved.caf;
  }
});

test('hover is coalesced per frame and only reaches the send state when the target changes', () => {
  const frames = new Map(); let next = 1;
  const saved = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = fn => { frames.set(next, fn); return next++; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  const rows = { a: row('a'), b: row('b') };
  function row(key) { return { closest: selector => (selector === '[data-lunii-drop]' ? { dataset: { luniiDrop: 'row', deviceId: 'd', rowKey: key } } : null) }; }
  let hovered = 'a'; const hovers = [];
  const lunii = { luniiDevices: [{ id: 'd', stories: [] }], send: { startDrag() {}, hover: (device, key) => { hovers.push(key); return true; }, leave() {}, endDrag() {} } };
  const app = runner(() => useLuniiDnd({ lunii, sendUi: { drag: { idsFor: id => [id] } }, onDeviceChange() {}, elementAt: () => rows[hovered] }));
  const flush = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  try {
    const hook = () => app.render().handlers;
    hook().onDragStart({ active: { data: { current: { kind: 'card', cardId: 'x' } } } });
    const move = () => hook().onDragMove({ activatorEvent: { clientX: 10, clientY: 10 }, delta: { x: 0, y: 0 } });
    move(); move(); move(); flush();
    assert.deepEqual(hovers, ['a'], 'several moves in one frame hit-test once');
    move(); flush(); move(); flush();
    assert.deepEqual(hovers, ['a'], 'same target: no new update');
    hovered = 'b'; move(); flush();
    assert.deepEqual(hovers, ['a', 'b'], 'new target: one update');
  } finally {
    app.unmount();
    globalThis.requestAnimationFrame = saved.raf; globalThis.cancelAnimationFrame = saved.caf;
  }
});


test('story reorder tracks viewport pointer through wheel and edge scrolling, including the final drop', () => {
  const saved = { document: globalThis.document, raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame };
  const listeners = new Map(), frames = new Map(); let next = 1;
  globalThis.document = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  globalThis.requestAnimationFrame = fn => { frames.set(next, fn); return next++; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  let scrollTop = 200;
  const list = { get scrollTop() { return scrollTop; }, set scrollTop(value) { scrollTop = Math.max(0, Math.min(1200, value)); }, getBoundingClientRect: () => ({ top: 100, bottom: 400 }) };
  const stories = Array.from({ length: 44 }, (_, index) => ({ key: String(index) }));
  const device = { id: 'd', stories }, drops = [], probes = [];
  const elementAt = (x, y) => {
    probes.push({ x, y });
    if (x < 100 || x > 300 || y < 100 || y > 400) return null;
    const key = String(Math.floor((scrollTop + y - 100) / 40));
    return { closest: selector => selector === '.lunii-scroll' ? list : { dataset: { luniiDrop: 'row', deviceId: 'd', rowKey: key } } };
  };
  const app = runner(() => useLuniiDnd({ lunii: { luniiDevices: [device], gestures: { reorder: (...args) => drops.push(args) } }, elementAt }));
  const hook = () => app.render();
  const flush = () => { const [id, fn] = [...frames][0]; frames.delete(id); fn(); };
  const event = delta => ({ activatorEvent: { clientX: 200, clientY: 300 }, delta: { x: 0, y: delta } });
  try {
    hook(); app.flush();
    hook().handlers.onDragStart({ ...event(0), active: { data: { current: { kind: 'lunii-row', deviceId: 'd', key: '1' } } } });
    hook().handlers.onDragMove(event(0)); flush();
    assert.equal(hook().insertion, '10');
    list.scrollTop += 200; listeners.get('scroll')();
    hook().handlers.onDragMove(event(200)); flush();
    assert.deepEqual(probes.at(-1), { x: 200, y: 300 }, 'wheel compensation never moves the viewport pointer');
    assert.equal(hook().insertion, '15', 'wheel re-reads the row under a stationary pointer');
    listeners.get('pointermove')({ clientX: 200, clientY: 105 });
    hook().handlers.onDragMove(event(-195)); flush();
    assert.ok(list.scrollTop < 400, 'top edge scrolls the list upwards');
    assert.equal(hook().insertion, String(Math.floor((list.scrollTop + 5) / 40)));
    const before = list.scrollTop;
    listeners.get('pointermove')({ clientX: 400, clientY: 105 });
    flush(); assert.equal(list.scrollTop, before, 'outside the column cannot scroll it');
    assert.equal(frames.size, 0);
    listeners.get('pointermove')({ clientX: 200, clientY: 395 });
    hook().handlers.onDragMove(event(800)); flush();
    assert.ok(list.scrollTop > before, 'bottom edge scrolls down');
    listeners.get('pointerup')({ clientX: 200, clientY: 300 });
    hook().handlers.onDragEnd(event(900));
    assert.equal(drops.length, 1);
    assert.equal(drops[0][2], Math.floor((list.scrollTop + 200) / 40), 'drop uses the final actual pointer, not scroll-adjusted delta');
    assert.equal(frames.size, 0, 'drop cancels edge scrolling');
    const keyboardEvent = { activatorEvent: { type: 'keydown' }, active: { rect: { current: { translated: { left: 195, top: 100, width: 10, height: 10 } } } } };
    hook().handlers.onDragStart({ ...keyboardEvent, active: { ...keyboardEvent.active, data: { current: { kind: 'lunii-row', deviceId: 'd', key: '1' } } } });
    const keyboardScroll = list.scrollTop;
    hook().handlers.onDragMove(keyboardEvent); flush();
    assert.equal(list.scrollTop, keyboardScroll, 'a keyboard target near the edge does not start continuous pointer scrolling');
    assert.equal(hook().insertion, String(Math.floor((list.scrollTop + 5) / 40)), 'keyboard still probes the moved handle centre');
    assert.equal(frames.size, 0);
    hook().handlers.onDragEnd(keyboardEvent);
    assert.equal(drops.length, 2);
    assert.equal(drops[1][2], Math.floor((list.scrollTop + 5) / 40));
  } finally {
    app.unmount(); assert.equal(listeners.size, 0);
    Object.assign(globalThis, { document: saved.document, requestAnimationFrame: saved.raf, cancelAnimationFrame: saved.caf });
  }
});
