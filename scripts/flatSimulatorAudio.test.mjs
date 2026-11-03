import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import react from '@vitejs/plugin-react';
import { createServer } from './viteTestServer.mjs';
import { installMountedDom } from './treeMountedDom.mjs';

class AudioFixture extends EventTarget {
  ended = false;
  destroyed = false;
  listeners = new Map();
  play = async () => {};
  destroy() { this.destroyed = true; }
  addEventListener(type, callback, options) {
    this.listeners.set(type, callback);
    super.addEventListener(type, callback, options);
  }
  removeEventListener(type, callback) {
    if (this.listeners.get(type) === callback) this.listeners.delete(type);
    super.removeEventListener(type, callback);
  }
  emit(type) { this.dispatchEvent(new Event(type)); }
}

test('FlatSimulator monté : attachement tardif, fins mémorisées, navigation et erreurs', async (t) => {
  const dom = installMountedDom();
  const pending = [];
  globalThis.__simAudioTest = {
    load: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    shell: null,
  };
  const server = await createServer({
    configFile: false,
    plugins: [{
      name: 'simulator-media-boundary', enforce: 'pre',
      transform(_code, id) {
        if (id.endsWith('/EmulatorTab/flatMedia.js')) return `
          export const loadFlatMedia = () => globalThis.__simAudioTest.load();
          export const createFlatAudio = (audio) => audio;
        `;
        if (id.endsWith('/EmulatorTab/LuniiShell.jsx')) return `
          export function LuniiShell(props) { globalThis.__simAudioTest.shell = props; return null; }
        `;
        if (id.endsWith('/EmulatorTab/FlatImage.jsx')) return 'export function FlatImage() { return null; }';
      },
    }, react()],
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  });
  const { FlatSimulator } = await server.ssrLoadModule('/src/tabs/EmulatorTab/FlatSimulator.jsx');
  const { initializeI18n } = await server.ssrLoadModule('/src/i18n/index.js');
  initializeI18n('fr');
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const host = dom.document.createElement('div');
  dom.document.body.appendChild(host);
  let root;
  let visited;
  const shell = () => globalThis.__simAudioTest.shell;
  const tick = (ms) => act(async () => {
    // Avancer par pas : les setTimeout récursifs doivent réellement sonder
    // 160 fois pendant les 16 s, et pas une fois à la toute fin de l'attente.
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      t.mock.timers.tick(Math.min(100, ms - elapsed));
    }
  });
  async function mount({ ok = true, autoplay = true } = {}) {
    if (root) await act(async () => root.unmount());
    pending.length = 0;
    visited = [];
    const stage = (id, auto = false) => ({
      id, name: id, audio: { kind: 'local', path: `${id}.mp3` },
      controlSettings: { autoplay: auto, ok, home: true, pause: true },
      okTransition: { actionNode: 'choices', optionIndex: 0 },
      homeTransition: { actionNode: 'manual', optionIndex: 0 },
    });
    const graph = {
      entryId: 'a', stages: new Map([['a', stage('a', autoplay)], ['b', stage('b')], ['c', stage('c')]]),
      actions: new Map([
        ['choices', { options: ['b', 'c', 'b', 'c', 'b', 'c'] }],
        ['manual', { options: ['c'] }],
      ]),
    };
    root = createRoot(host);
    await act(async () => root.render(React.createElement(FlatSimulator, {
      source: { kind: 'document', graph }, onActiveNodeChange: (id) => visited.push(id),
    })));
  }
  async function supply(audio = new AudioFixture()) {
    assert.ok(pending.length);
    await act(async () => pending.shift().resolve(audio));
    return audio;
  }
  try {
    // Le lecteur apparaît après l'ancienne limite de 15 secondes.
    await mount({ ok: false });
    await tick(16_000);
    const late = await supply();
    await tick(100);
    assert.ok(late.listeners.has('ended'));
    const oldEnd = late.listeners.get('ended');
    await act(async () => { late.emit('ended'); late.emit('error'); });
    assert.deepEqual(visited, ['a', 'b']);
    assert.equal(shell().sub, '1 / 6');
    assert.equal(late.listeners.size, 0, 'nettoyage sur le lecteur réellement abonné');
    const next = await supply();
    await act(async () => { oldEnd(); late.emit('ended'); });
    assert.deepEqual(visited, ['a', 'b']);
    assert.equal(next.destroyed, false);

    // Navigation manuelle avant la fin, puis livraison tardive de l'ancien événement.
    await mount();
    const previous = await supply();
    await tick(100);
    const stale = previous.listeners.get('ended');
    await act(async () => shell().onHome());
    assert.deepEqual(visited, ['a', 'c']);
    await supply();
    await act(async () => { stale(); previous.emit('error'); });
    assert.deepEqual(visited, ['a', 'c']);
    assert.equal(previous.listeners.size, 0);

    // Le son court a déjà fini avant le premier sondage ; Auto est réactivable.
    await mount();
    await act(async () => shell().chromeControls.toggleAutoPlayback());
    const short = new AudioFixture();
    short.ended = true;
    await supply(short);
    await tick(1000);
    assert.deepEqual(visited, ['a']);
    await act(async () => shell().chromeControls.toggleAutoPlayback());
    await tick(100);
    assert.deepEqual(visited, ['a', 'b']);

    // Pas d'autoplay : la fin ne navigue pas, OK reste utilisable.
    await mount({ autoplay: false });
    const manual = await supply();
    await tick(100);
    await act(async () => manual.emit('ended'));
    assert.deepEqual(visited, ['a']);
    await act(async () => shell().onOk());
    assert.deepEqual(visited, ['a', 'b']);

    // Fichier absent, erreur de lecture précoce et erreur de chargement : repli silencieux.
    for (const failure of ['absent', 'play', 'load', 'decode']) {
      await mount();
      if (failure === 'load') {
        await act(async () => pending.shift().reject(new Error('fixture load')));
      } else if (failure === 'absent') {
        await supply(null);
      } else {
        const audio = new AudioFixture();
        if (failure === 'play') audio.play = async () => { throw new Error('fixture play'); };
        await supply(audio);
        if (failure === 'decode') {
          await tick(100);
          await act(async () => { audio.emit('error'); audio.emit('ended'); });
        }
      }
      await tick(300);
      assert.deepEqual(visited, ['a', 'b'], failure);
    }
  } finally {
    if (root) await act(async () => root.unmount());
    t.mock.timers.reset();
    await server.close();
    delete globalThis.__simAudioTest;
    dom.restore();
  }
});
