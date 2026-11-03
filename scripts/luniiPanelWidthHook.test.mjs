import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { runner } from './reactHookDriver.mjs';
// The driver treats layout effects as commit effects.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'react' && context.parentURL?.endsWith('/useLuniiPanelWidth.js')) {
    const driver = new URL('./reactHookDriver.mjs', import.meta.url).href;
    return { url: 'data:text/javascript,' + encodeURIComponent(`export * from '${driver}'; export { useEffect as useLayoutEffect } from '${driver}';`), shortCircuit: true };
  }
  return next(specifier, context);
} });
const { useLuniiPanelWidth } = await import('../src/hooks/useLuniiPanelWidth.js');

test('unchanged width after a resize notification keeps the value; a change applies only on the frame', () => {
  const saved = ['ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'].map(n => [n, globalThis[n]]);
  const frames = new Map(); let id = 0; let deliver;
  globalThis.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  globalThis.cancelAnimationFrame = n => { frames.delete(n); };
  globalThis.ResizeObserver = class { constructor(cb) { deliver = cb; } observe() {} disconnect() {} };
  try {
    const parent = { clientWidth: 1000 };
    const hook = runner(() => useLuniiPanelWidth(900, true, false));
    let view = hook.render(); view.panelRef.current = { parentElement: parent }; hook.flush();
    view = hook.render();
    assert.equal(view.max, 640);
    deliver(); [...frames.values()].forEach(f => f()); frames.clear();
    assert.equal(hook.render().max, 640);
    parent.clientWidth = 800; deliver();
    assert.equal(hook.render().max, 640);
    [...frames.values()].forEach(f => f()); frames.clear();
    assert.equal(hook.render().max, 440);
    deliver(); hook.unmount();
    assert.equal(frames.size, 0);
  } finally { for (const [n, v] of saved) v === undefined ? delete globalThis[n] : globalThis[n] = v; }
});
