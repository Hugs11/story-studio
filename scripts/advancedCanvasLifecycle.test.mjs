import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';

const { useAdvancedGraphView } = await import('../src/components/AdvancedGraphCanvas/useAdvancedGraphView.js');
const { useGraphCanvasEngine } = await import('../src/components/AdvancedGraphCanvas/useGraphCanvasEngine.js');
const path = id => `/stageNodes/@uuid=${id}#0`;
const graph = id => ({
  viewVersion: 1, documentFingerprint: id,
  entry: { status: 'unique', stagePath: path(id) },
  stages: [{ uuid: id, path: path(id), layout: { x: 0, y: 0 } }],
  actions: [], edges: [], mediaRefs: [], diagnostics: [],
});
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { resolve, promise };
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };

function harness({ readGraphView = async id => graph(id), firstMount = null } = {}) {
  let cacheReads = 0;
  const writes = [];
  let props = {
    payload: 'a', projectEpoch: 1,
    projectDescriptor: { packIdentity: 'p', savePath: '/tmp/hook-A.mbah' },
    bridge: {
      readGraphView,
      readViewCache: async () => { cacheReads++; return { view: {
        viewport: { x: 10, y: 0, zoom: 1 },
        selection: { stages: [path('a'), path('missing')], actions: [] },
      } }; },
      writeViewCache: async value => { writes.push(value); },
    },
  };
  let view;
  const engines = [];
  let authored = [];
  const hostRef = { current: { clientWidth: 800, clientHeight: 600 } };
  const createEngine = async (_id, callbacks) => {
    const instance = {
      callbacks, destroyed: 0, mounts: 0, selections: [],
      async mount() { this.mounts++; if (engines.length === 1 && firstMount) await firstMount; },
      async setViewport(value) { callbacks.onViewportChange(value); },
      async setDetailLevel() {},
      async setPresentation() {},
      async setSelection(value) { this.selections.push(value); callbacks.onSelect(value); },
      destroy() { this.destroyed++; },
      resize() {},
    };
    engines.push(instance);
    return instance;
  };
  const hookRunner = runner(() => useAdvancedGraphView(props));
  const engineRunner = runner(() => useGraphCanvasEngine({
    hostRef, view, engineId: 'test', createEngine, onClamp: () => {},
    onAuthoredPositionsChange: (entries) => authored.push(entries),
  }));
  return {
    engines,
    writes,
    get view() { return view; },
    get cacheReads() { return cacheReads; },
    get authored() { return authored; },
    change(next) { props = { ...props, ...next }; },
    async render() {
      for (let i = 0; i < 3; i++) {
        view = hookRunner.render(); hookRunner.flush();
        engineRunner.render(); engineRunner.flush();
        await tick();
      }
    },
    replay() { hookRunner.replayEffects(); engineRunner.replayEffects(); },
    close() { engineRunner.unmount(); hookRunner.unmount(); },
  };
}

test('pan/zoom et callback auteur ne remontent pas le renderer ; restauration sans purge', async () => {
  const h = harness();
  try {
    await h.render();
    const first = h.engines[0];
    const initialViewport = h.view.initialViewport;
    assert.equal(h.engines.length, 1);
    for (let i = 0; i < 30; i++) {
      first.callbacks.onViewportChange({ x: i, y: 2, zoom: 1 + i / 10 });
      await h.render();
    }
    assert.equal(h.engines.length, 1);
    assert.equal(first.destroyed, 0);
    assert.equal(h.view.initialViewport, initialViewport);
    assert.equal(h.cacheReads, 1);
    // L'ancrage non affiché n'est pas purgé par l'écho de setSelection.
    await h.view.session.flush({ timeoutMs: null });
    assert.deepEqual(h.writes.at(-1).view.selection.stages, [path('a'), path('missing')]);
    h.view.session.noteViewEvent('focus', { focus: path('missing') });
    first.callbacks.onNodeDragEnd(path('a'), { x: 12, y: 34 });
    await tick();
    assert.deepEqual(h.authored, [[{ path: path('a'), x: 12, y: 34 }]]);
  } finally { h.close(); await tick(); }
});

test('un glisser de sélection livre toutes ses positions en une seule fois', async () => {
  const h = harness();
  try {
    await h.render();
    const { callbacks } = h.engines[0];
    // Le moteur rend une fin de glisser par nœud entraîné, dans le même tour.
    callbacks.onNodeDragEnd(path('a'), { x: 1.4, y: 2 });
    callbacks.onNodeDragEnd(path('b'), { x: 3, y: 4 });
    callbacks.onNodeDragEnd(path('c'), { x: 5, y: 6 });
    assert.equal(h.authored.length, 0);
    await tick();
    assert.deepEqual(h.authored, [[
      { path: path('a'), x: 1, y: 2 },
      { path: path('b'), x: 3, y: 4 },
      { path: path('c'), x: 5, y: 6 },
    ]]);
    // Le glisser suivant est un autre geste.
    callbacks.onNodeDragEnd(path('b'), { x: 7, y: 8 });
    await tick();
    assert.equal(h.authored.length, 2);
    assert.deepEqual(h.authored[1], [{ path: path('b'), x: 7, y: 8 }]);
  } finally { h.close(); await tick(); }
});

test('édition et Save As conservent la caméra sans rouvrir le cache', async () => {
  const h = harness();
  try {
    await h.render();
    h.engines[0].callbacks.onViewportChange({ x: 30, y: 5, zoom: 2 });
    h.change({ payload: 'missing' }); await h.render();
    assert.equal(h.cacheReads, 1);
    assert.equal(h.view.ticket.documentRevision, 1);
    assert.equal(h.view.viewport.x, 30);
    assert.deepEqual(h.view.selection.stages, [path('missing')]);
    const before = h.engines.length;
    h.change({ projectDescriptor: { packIdentity: 'p', savePath: '/tmp/hook-B.mbah' } });
    await h.render();
    assert.equal(h.cacheReads, 1);
    assert.equal(h.engines.length, before);
    assert.equal(h.view.ticket.documentRevision, 1);
    assert.equal(h.view.viewport.x, 30);
  } finally { h.close(); await tick(); }
});

test('StrictMode et réponses inversées ne réinstallent pas le premier payload', async () => {
  const first = deferred(); let calls = 0;
  const h = harness({ readGraphView: id => ++calls === 1 ? first.promise : Promise.resolve(graph(id)) });
  try {
    await h.render(); h.replay(); await h.render();
    h.change({ payload: 'new' }); await h.render();
    first.resolve(graph('old')); await h.render();
    assert.equal(h.view.view.stages[0].uuid, 'new');
    assert.equal(h.view.status, 'ready');
    h.change({ payload: null }); await h.render();
    assert.equal(h.view.index, null);
    assert.equal(h.view.status, 'idle');
    assert.ok(h.engines.every(e => e.destroyed === 1));
  } finally { h.close(); await tick(); }
});

test('un montage asynchrone périmé est détruit sans détruire son successeur', async () => {
  const mounting = deferred();
  const h = harness({ firstMount: mounting.promise });
  try {
    await h.render();
    const old = h.engines[0];
    h.change({ payload: 'next' }); await h.render();
    const current = h.engines.at(-1);
    assert.notEqual(old, current);
    mounting.resolve(); await h.render();
    assert.equal(old.destroyed, 1);
    assert.equal(current.destroyed, 0);
    old.callbacks.onViewportChange({ x: 999, y: 0, zoom: 1 });
    assert.notEqual(h.view.session.state.viewport.x, 999);
  } finally { mounting.resolve(); h.close(); await tick(); }
});

test('Save As pendant la première lecture installe le graphe et son cache avec une empreinte', async () => {
  const first = deferred(); let count = 0;
  const h = harness({ readGraphView: id => ++count === 1 ? first.promise : Promise.resolve(graph(id)) });
  try {
    await h.render();
    h.change({ projectDescriptor: { packIdentity: 'p', savePath: '/tmp/hook-loading-copy.mbah' } });
    await h.render();
    first.resolve(graph('old')); await h.render();
    assert.equal(h.view.view.stages[0].uuid, 'a');
    assert.equal(h.view.status, 'ready');
    await h.view.session.flush({ timeoutMs: null });
    assert.equal(h.writes.at(-1).project.savePath, '/tmp/hook-loading-copy.mbah');
    assert.equal(h.writes.at(-1).fingerprint, 'a');
  } finally { first.resolve(graph('old')); h.close(); await tick(); }
});
