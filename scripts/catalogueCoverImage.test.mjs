import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
const { useCatalogueCoverImage } = await import('../src/hooks/useCatalogueCoverImage.js');
import { coverAddress } from '../src/store/catalogue/coverAddress.js';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';

test('metadata revisions keep the same image address; a cached remount skips fading', () => {
  let card = normalizeEntry({ id: 'a', coverSignature: 'a'.repeat(64), ficheRevision: 1 });
  const address = () => coverAddress(card.id, card.coverSignature, () => 'scheme://localhost/');
  const hook = runner(() => useCatalogueCoverImage(address()));
  let cover = hook.render();
  cover.image.current = { complete: true, naturalWidth: 768 };
  hook.flush(); cover = hook.render(); hook.flush();
  assert.deepEqual(cover.state, { phase: 'ready', attempt: 0, fade: false });
  const src = cover.src;
  for (const mutation of [{ favorite: true }, { tagIds: ['tag'] }, { ficheRevision: 99 }]) {
    card = { ...card, ...mutation };
    cover = hook.render(); hook.flush();
    assert.equal(cover.src, src); assert.equal(cover.state.phase, 'ready');
    assert.equal(card.coverSignature, 'a'.repeat(64));
  }
  hook.replayEffects(); cover = hook.render();
  assert.equal(cover.state.fade, false, 'StrictMode replay also handles cached images');
  hook.unmount();
});

test('unmount cancels the old image handlers before mounting another fiche', () => {
  const old = runner(() => useCatalogueCoverImage('old'));
  const previous = old.render(); old.flush(); old.unmount();
  previous.onLoad(); previous.onError();
  const next = runner(() => useCatalogueCoverImage('new'));
  let cover = next.render(); next.flush();
  assert.equal(cover.src, 'new'); assert.equal(cover.state.phase, 'waiting');
  cover.onLoad(); cover = next.render();
  assert.equal(cover.state.phase, 'ready'); assert.equal(cover.state.fade, true);
  next.unmount();
});

const tick = () => new Promise(resolve => setImmediate(resolve));
for (const phase of ['absent', 'unreadable', 'tooLarge', 'offline']) test(`terminal ${phase} remount is synchronous and makes no request`, async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { status: phase === 'offline' ? 503 : 422, headers: new Headers({ 'x-cover-state': phase }) }; };
  const address = `terminal-${phase}`;
  const first = runner(() => useCatalogueCoverImage(address, 'a'));
  try {
    let cover = first.render(); first.flush(); cover.onError(); await tick();
    cover = first.render(); assert.equal(cover.state.phase, phase); assert.equal(cover.src, null);
    first.unmount();
    const second = runner(() => useCatalogueCoverImage(address, 'a'));
    try {
      cover = second.render();
      assert.equal(cover.state.phase, phase, 'terminal state before effects');
      assert.equal(cover.src, null, 'no image to trigger a GET');
      second.flush(); cover.onError(); await tick();
      assert.equal(calls, 1, 'only the first mount issued a HEAD');
    } finally { second.unmount(); }
  } finally { first.unmount(); globalThis.fetch = saved; }
});

test('fingerprint replacement keeps the same fiche image until ready; another fiche never inherits it', () => {
  let address = 'replacement-old', fiche = 'a';
  const hook = runner(() => useCatalogueCoverImage(address, fiche));
  let cover = hook.render(); hook.flush(); cover.onLoad(); cover = hook.render();
  assert.equal(cover.state.fade, true);
  address = 'replacement-new';
  cover = hook.render(); assert.equal(cover.fallbackSrc, 'replacement-old', 'retained before effects');
  // A new keyed img is not yet complete; the old decoded DOM image is separate.
  cover.image.current = { complete: false };
  hook.flush(); cover = hook.render();
  assert.equal(cover.fallbackSrc, 'replacement-old', 'retained while new image is pending');
  assert.equal(cover.src, 'replacement-new');
  cover.onLoad(); cover = hook.render();
  assert.equal(cover.fallbackSrc, null); assert.equal(cover.state.phase, 'ready');
  assert.equal(cover.state.fade, false, 'replacement has no fade to an empty frame');
  fiche = 'b'; address = 'other-fiche';
  cover = hook.render();
  assert.equal(cover.fallbackSrc, null, 'no other fiche image even before effects');
  assert.equal(cover.state.phase, 'waiting');
  hook.flush(); hook.unmount();
});

for (const phase of ['absent', 'unreadable', 'tooLarge', 'offline']) test(`replacement ending in ${phase} ${phase === 'offline' ? 'keeps' : 'removes'} the previous image`, async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ status: phase === 'offline' ? 503 : 422, headers: new Headers({ 'x-cover-state': phase }) });
  let address = `end-${phase}-old`;
  const hook = runner(() => useCatalogueCoverImage(address, 'a'));
  try {
    let cover = hook.render(); hook.flush(); cover.onLoad(); hook.render();
    address = `end-${phase}-new`;
    cover = hook.render(); cover.image.current = { complete: false }; hook.flush();
    cover.onError(); await tick(); cover = hook.render();
    assert.equal(cover.state.phase, phase); assert.equal(cover.src, null);
    assert.equal(cover.fallbackSrc, phase === 'offline' ? `end-${phase}-old` : null);
    // A subsequent address must not resurrect a cover discarded by a terminal result.
    address = `end-${phase}-third`; cover = hook.render();
    assert.equal(cover.fallbackSrc, phase === 'offline' ? `end-${phase}-old` : null);
  } finally { hook.unmount(); globalThis.fetch = saved; }
});

test('surface keeps a visible old img beside the hidden replacement until load, then switches without fading', async () => {
  const { registerHooks } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { transformSync } = await import('rolldown/experimental');
  registerHooks({ load(url, context, next) {
    if (url.endsWith('.jsx')) return { format: 'module', source: `import * as TestReact from '${new URL('../node_modules/react/index.js', import.meta.url).href}';\n` + transformSync(fileURLToPath(url), readFileSync(fileURLToPath(url), 'utf8'), { jsx: { runtime: 'classic', pragma: 'TestReact.createElement' } }).code, shortCircuit: true };
    return next(url, context);
  } });
  const { CoverImage } = await import('../src/components/Catalogue/views/CoverImage.jsx');
  let props = { ficheId: 'surface-a', coverSignature: 'd'.repeat(64) };
  // The inner surface receives a stable fiche key from its enclosing component.
  const savedWindow = globalThis.window;
  globalThis.window = { __TAURI_INTERNALS__: { convertFileSrc: (path, protocol) => `${protocol}://localhost/${path}` } };
  const element = () => CoverImage(props);
  const hook = runner(() => { const view = element(); return view.type(view.props); });
  const images = view => view.props.children.flat().filter(child => child?.type === 'img');
  try {
    let view = hook.render(); hook.flush(); images(view)[0].props.onLoad(); view = hook.render();
    const oldSrc = images(view)[0].props.src;
    const oldKey = images(view)[0].key;
    props = { ...props, coverSignature: 'e'.repeat(64) };
    view = hook.render();
    assert.equal(images(view)[0].props.src, oldSrc);
    assert.equal(images(view)[0].key, oldKey, 'React retains the decoded DOM image during replacement');
    assert.equal(images(view)[0].props.className, undefined, 'old image remains visible before effects');
    images(view)[1].props.ref.current = { complete: false };
    hook.flush(); view = hook.render();
    assert.equal(images(view).length, 2);
    assert.equal(images(view)[0].props.src, oldSrc);
    assert.equal(images(view)[1].props.className, 'catalogue-cover-pending');
    const newSrc = images(view)[1].props.src;
    images(view)[1].props.onLoad(); view = hook.render();
    assert.equal(images(view).length, 1);
    assert.equal(images(view)[0].props.src, newSrc);
    assert.equal(images(view)[0].props.className, undefined);
    props = { ...props, ficheId: 'surface-b' }; view = hook.render();
    assert.equal(images(view).length, 1);
    assert.equal(images(view)[0].props.className, 'catalogue-cover-pending');
    assert.ok(!images(view).some(image => image.props.src === newSrc), 'another fiche has no visible fallback');
  } finally { hook.unmount(); if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow; }
});

test('an http page with a non-http cover scheme (Linux/macOS dev) loads covers through blob URLs', async () => {
  const { coverNeedsBlob, loadCoverBlob } = await import('../src/store/catalogue/coverDisplay.js');
  // WebKitGTK: <img src="catalogue-cover://…"> from http://127.0.0.1:1420 is refused, fetch is not.
  assert.equal(coverNeedsBlob('catalogue-cover://localhost', 'http:'), true, 'Linux/macOS dev');
  assert.equal(coverNeedsBlob('catalogue-cover://localhost', 'tauri:'), false, 'Linux/macOS production');
  assert.equal(coverNeedsBlob('http://catalogue-cover.localhost', 'http:'), false, 'Windows');
  assert.equal(coverNeedsBlob(null, 'http:'), false, 'outside Tauri');
  const requests = [];
  let status = 200;
  const load = address => loadCoverBlob(address, {
    request: async url => { requests.push(url); return { status, blob: async () => ({ url }) }; },
    create: blob => `blob:${blob.url}`, revoke: () => {},
  });
  const hook = runner(() => useCatalogueCoverImage('blob-cover', 'a', { blob: true, load }));
  try {
    let cover = hook.render(); hook.flush();
    assert.equal(cover.src, null, 'no <img> with the raw address');
    await tick(); cover = hook.render(); hook.flush();
    assert.equal(cover.src, 'blob:blob-cover');
    cover.onLoad(); cover = hook.render();
    assert.equal(cover.state.phase, 'ready');
    assert.deepEqual(requests, ['blob-cover']);
  } finally { hook.unmount(); }
  const saved = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 422, headers: new Headers({ 'x-cover-state': 'unreadable' }) });
  status = 422;
  const failing = runner(() => useCatalogueCoverImage('blob-failing', 'b', { blob: true, load }));
  try {
    failing.render(); failing.flush(); await tick(); await tick();
    const cover = failing.render();
    assert.equal(cover.state.phase, 'unreadable', 'a refused fetch goes through the HEAD diagnosis');
    assert.equal(cover.src, null);
  } finally { failing.unmount(); globalThis.fetch = saved; }
});

test('useDisplayableCover: any custom scheme goes through a blob on an http page, directly otherwise', async () => {
  const { useDisplayableCover } = await import('../src/hooks/useDisplayableCover.js');
  const { coverNeedsBlob, loadCoverBlob } = await import('../src/store/catalogue/coverDisplay.js');
  assert.equal(coverNeedsBlob('lunii-cover://localhost/v1/a.jpg', 'http:'), true);
  assert.equal(coverNeedsBlob('lunii-cover://localhost/v1/a.jpg', 'tauri:'), false);
  assert.equal(coverNeedsBlob('http://lunii-cover.localhost/v1/a.jpg', 'http:'), false);
  assert.equal(coverNeedsBlob('blob:x', 'http:'), false);
  const requests = [];
  const load = address => loadCoverBlob(address, {
    request: async url => { requests.push(url); return { status: 200, blob: async () => ({ url }) }; },
    create: blob => `blob:${blob.url}`, revoke: () => {},
  });
  const address = 'lunii-cover://localhost/v1/story-a.jpg';
  const dev = runner(() => useDisplayableCover(address, { protocol: 'http:', load }));
  try {
    assert.equal(dev.render(), null, 'not ready: fallback icon');
    dev.flush(); await tick();
    assert.equal(dev.render(), `blob:${address}`);
    assert.deepEqual(requests, [address]);
  } finally { dev.unmount(); }
  const prod = runner(() => useDisplayableCover(address, { protocol: 'tauri:', load }));
  try {
    assert.equal(prod.render(), address); prod.flush();
    assert.equal(requests.length, 1, 'no fetch in production');
  } finally { prod.unmount(); }
  const none = runner(() => useDisplayableCover(null, { protocol: 'http:', load }));
  try { assert.equal(none.render(), null); } finally { none.unmount(); }
});
