import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvancedViewSession, VIEW_EVENTS, DOCUMENT_EVENTS } from '../src/store/advancedGraphView/advancedViewSession.js';

const path = id => `/stageNodes/@uuid=${id}#0`;
const project = id => ({ packIdentity: 'same-pack', savePath: `/tmp/revue-${id}.mbah` });
const camera = x => ({ x, y: 0, zoom: 1 });
const graph = (ids = ['a', 'b']) => ({
  viewVersion: 1, documentFingerprint: ids.join(','),
  entry: { status: 'unique', stagePath: path(ids[0]) },
  stages: ids.map(uuid => ({ uuid, path: path(uuid), layout: { x: 0, y: 0 } })),
  actions: [], edges: [], mediaRefs: [], diagnostics: [],
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};
function harness(overrides = {}) {
  const timers = new Map();
  const writes = [];
  let n = 0;
  const session = createAdvancedViewSession({
    readGraphView: async () => graph(), readViewCache: async () => null,
    writeViewCache: async value => { writes.push(structuredClone(value)); },
    now: () => 0,
    setTimer: callback => { timers.set(++n, callback); return n; },
    clearTimer: id => timers.delete(id), ...overrides,
  });
  return { session, writes, async fire() {
    const pending = [...timers.values()]; timers.clear();
    for (const callback of pending) callback();
    for (let i = 0; i < 30; i++) await Promise.resolve();
  } };
}


// Cache A en vol, B installé, puis réponse A.
test('une lecture de cache tardive ne remplace pas la vue du nouveau projet', async () => {
  const late = deferred(); const started = deferred();
  const h = harness({ readViewCache: ({ project: p }) => {
    if (p.savePath === project('A').savePath) { started.resolve(); return late.promise; }
    return Promise.resolve({ view: { viewport: camera(20) } });
  } });
  const opening = h.session.open({ projectEpoch: 1, project: project('A') });
  await started.promise;
  await h.session.open({ projectEpoch: 2, project: project('B') });
  late.resolve({ view: { viewport: camera(10) } });
  await opening;
  assert.equal(h.session.state.ticket.projectEpoch, 2);
  assert.equal(h.session.state.viewport.x, 20);
});

// Le timer de A survit à open(B) et relit les variables de B.
test('un ancien timer conserve la caméra de son propre projet', async () => {
  const h = harness();
  await h.session.open({ projectEpoch: 1, project: project('A') });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(10) });
  await h.session.open({ projectEpoch: 2, project: project('B') });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(20) });
  await h.fire();
  const old = h.writes.find(w => w.project.savePath === project('A').savePath);
  assert.equal(old.view.viewport.x, 10);
});

// Supprimer puis annuler ne restitue pas la sélection mémorisée.
test('la sélection revient après suppression puis undo', async () => {
  let current = graph();
  const h = harness({ readGraphView: async () => current });
  await h.session.open({ projectEpoch: 1, project: project('A') });
  h.session.noteViewEvent(VIEW_EVENTS.SELECTION, { selection: { stages: [path('b')], actions: [] } });
  await h.fire();
  current = graph(['a']);
  await h.session.noteDocumentEvent(DOCUMENT_EVENTS.AUTHOR_GESTURE);
  current = graph();
  await h.session.noteDocumentEvent(DOCUMENT_EVENTS.UNDO);
  assert.deepEqual(h.session.state.selection.stages, [path('b')]);
});

// Pan pendant la lecture d'auteur, caméra remise à l'ancien état.
test('un pan pendant une lecture auteur reste courant', async () => {
  let read = async () => graph();
  const h = harness({ readGraphView: () => read() });
  await h.session.open({ projectEpoch: 1, project: project('A') });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(10) });
  const late = deferred(); read = () => late.promise;
  const updating = h.session.noteDocumentEvent(DOCUMENT_EVENTS.AUTHOR_GESTURE);
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(20) });
  late.resolve(graph()); await updating;
  assert.equal(h.session.state.viewport.x, 20);
});

// Deux open de la même époque ne périment pas la première lecture.
test('deux ouvertures de même époque ignorent la première réponse tardive', async () => {
  const late = deferred(); let count = 0;
  const h = harness({ readGraphView: () => ++count === 1 ? late.promise : Promise.resolve(graph(['new'])) });
  const old = h.session.open({ projectEpoch: 1, project: project('A') });
  await h.session.open({ projectEpoch: 1, project: project('A') });
  late.resolve(graph(['old'])); await old;
  assert.equal(h.session.state.view.stages[0].uuid, 'new');
});

for (const phase of ['graph', 'cache']) {
  test(`une erreur tardive de ${phase} est ignorée après remplacement`, async () => {
    const late = deferred(); const entered = deferred(); let first = true;
    const read = () => {
      if (!first) return Promise.resolve(phase === 'graph' ? graph() : null);
      first = false; entered.resolve(); return late.promise;
    };
    const h = harness(phase === 'graph' ? { readGraphView: read } : { readViewCache: read });
    const old = h.session.open({ projectEpoch: 1, project: project(`error-${phase}-A`) });
    await entered.promise;
    await h.session.open({ projectEpoch: 2, project: project(`error-${phase}-B`) });
    late.reject(new Error('ancienne erreur'));
    assert.deepEqual(await old, { installed: false });
    assert.deepEqual(h.session.state.notices, []);
  });
}

test('les ancrages absents survivent à un pan et à une réouverture', async () => {
  let current = graph(['a']); let cached = {
    view: { viewport: camera(1), selection: { stages: [path('b')], actions: [] }, lastFocusedPath: path('b') },
  };
  const h = harness({ readGraphView: async () => current, readViewCache: async () => cached,
    writeViewCache: async ({ view }) => { cached = { view }; },
  });
  await h.session.open({ projectEpoch: 1, project: project('anchors') });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(20) });
  await h.session.flush({ timeoutMs: null });
  assert.deepEqual(cached.view.selection.stages, [path('b')]);
  assert.equal(cached.view.lastFocusedPath, path('b'));
  current = graph(['b', 'a']);
  await h.session.open({ projectEpoch: 2, project: project('anchors') });
  assert.deepEqual(h.session.state.selection.stages, [path('b')]);
  assert.equal(h.session.state.focus, path('b'));
});

test('Save As pendant une écriture suspendue sépare clé, empreinte et caméra sur disque', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const { join } = await import('node:path');
  const dir = await fs.mkdtemp(join(os.tmpdir(), 'g1-view-race-'));
  const old = { packIdentity: 'p', savePath: join(dir, 'source.mbah') };
  const copy = { packIdentity: 'p', savePath: join(dir, 'copy.mbah') };
  const entered = deferred(); const release = deferred();
  let current = graph(['before']); let count = 0;
  const h = harness({ readGraphView: async () => current, writeViewCache: async value => {
    if (++count === 1) { entered.resolve(); await release.promise; }
    await fs.writeFile(`${value.project.savePath}.view.json`, JSON.stringify(value));
  } });
  try {
    await h.session.open({ projectEpoch: 1, project: old });
    h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(10) });
    const pending = h.session.flush({ timeoutMs: null });
    await entered.promise;
    h.session.rebindProject(copy);
    current = graph(['after']);
    await h.session.noteDocumentEvent(DOCUMENT_EVENTS.AUTHOR_GESTURE);
    h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(20) });
    await h.session.flush({ timeoutMs: null });
    release.resolve(); await pending;
    const source = JSON.parse(await fs.readFile(`${old.savePath}.view.json`));
    const target = JSON.parse(await fs.readFile(`${copy.savePath}.view.json`));
    assert.equal(source.view.viewport.x, 10);
    assert.equal(source.fingerprint, 'before');
    assert.equal(target.view.viewport.x, 20);
    assert.equal(target.fingerprint, 'after');
    assert.equal(h.session.state.viewport.x, 20);
  } finally { release.resolve(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('revisiter une clé attend toute son ancienne vidange, sans écrasement final', async () => {
  const entered = deferred(); const release = deferred(); const writes = [];
  const h = harness({ writeViewCache: async value => {
    if (!writes.length) { writes.push('in-flight'); entered.resolve(); await release.promise; }
    writes.push(value.view.viewport.x);
  } });
  await h.session.open({ projectEpoch: 1, project: project('revisit') });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(10) });
  const old = h.session.flush({ timeoutMs: null });
  await entered.promise;
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(11) });
  await h.session.open({ projectEpoch: 2, project: project('revisit') });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(20) });
  const next = h.session.flush({ timeoutMs: null });
  release.resolve();
  await Promise.all([old, next]);
  assert.deepEqual(writes, ['in-flight', 10, 11, 20]);
});

test('close invalide une ouverture en cours et ne laisse aucun timer réécrire la nouvelle vue', async () => {
  const late = deferred();
  const h = harness({ readGraphView: () => late.promise });
  const opening = h.session.open({ projectEpoch: 1, project: project('close') });
  await h.session.close();
  late.resolve(graph());
  assert.deepEqual(await opening, { installed: false });
  assert.equal(h.session.state.index, null);
  await h.fire();
  assert.deepEqual(h.writes, []);
});

test('une visite intermédiaire sans geste ne rompt pas la file de vidange de la clé', async () => {
  const entered = deferred(); const release = deferred(); const writes = [];
  const h = harness({ writeViewCache: async value => {
    if (!writes.length) { writes.push('in-flight'); entered.resolve(); await release.promise; }
    writes.push(value.view.viewport.x);
  } });
  const descriptor = project('three-visits');
  await h.session.open({ projectEpoch: 1, project: descriptor });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(10) });
  const old = h.session.flush({ timeoutMs: null });
  await entered.promise;
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(11) });
  await h.session.open({ projectEpoch: 2, project: descriptor });
  await h.session.open({ projectEpoch: 3, project: descriptor });
  h.session.noteViewEvent(VIEW_EVENTS.PAN, { viewport: camera(30) });
  const next = h.session.flush({ timeoutMs: null });
  release.resolve(); await Promise.all([old, next]);
  assert.deepEqual(writes, ['in-flight', 10, 11, 30]);
});
