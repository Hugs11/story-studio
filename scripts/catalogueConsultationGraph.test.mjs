// Le simulateur d'une consultation joue le même graphe que l'ancien chemin.
//
// Référence : `packFlatGraph(story, zipPath)`, le code existant de
// `FlatSimulator` pour `load_pack_zip { forSimulation }`, sur un `story.json`
// tiré de la source d'origine (voir `origin` dans la fixture). La consultation
// reçoit le même document, médias remplacés par des identifiants opaques
// (correspondance écrite à la main ici, la réécriture réelle est vérifiée côté
// Rust contre `load_pack_zip_for_simulation`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from './viteTestServer.mjs';
import react from '@vitejs/plugin-react';
import fixture from './fixtures/catalogue/consultation-story.json' with { type: 'json' };
import {
  consultationFlatGraph, documentFlatGraph, mediaRequestKey, packFlatGraph, MEDIA_FROM_CONSULTATION, MEDIA_FROM_PACK,
} from '../src/tabs/EmulatorTab/flatGraph.js';
import { presence } from './advancedViewFixtures.mjs';

test('the common URL cache never replaces a displayed URL during concurrent completion', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const original = URL.revokeObjectURL;
  const revoked = [];
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const { createUrlCache } = await server.ssrLoadModule('/src/tabs/EmulatorTab/useUrlCache.js');
    const cache = createUrlCache();
    assert.equal(cache.set('image', 'blob:displayed'), 'blob:displayed');
    assert.equal(cache.set('image', 'blob:unused'), 'blob:displayed');
    assert.equal(cache.set('image', 'blob:displayed'), 'blob:displayed');
    assert.deepEqual(revoked, ['blob:unused']);
    cache.delete('image');
    cache.revokeAll();
    assert.deepEqual(revoked, ['blob:unused', 'blob:displayed']);
  } finally {
    URL.revokeObjectURL = original;
    await server.close();
  }
});

test('concurrent image loads keep the displayed URL alive until disposal', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const created = [], revoked = [];
  const original = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  URL.createObjectURL = () => { const url = `blob:race/${created.length}`; created.push(url); return url; };
  URL.revokeObjectURL = url => revoked.push(url);
  try {
    const { createConsultationMediaLoader } = await server.ssrLoadModule('/src/tabs/EmulatorTab/flatMedia.js');
    let resolve;
    const data = new Promise(done => { resolve = done; });
    const loader = createConsultationMediaLoader({ readAsset: () => data });
    const request = { kind: MEDIA_FROM_CONSULTATION, consultationId: 'race', mediaId: 'image' };
    const first = loader.loadImageUrl(request);
    const second = loader.loadImageUrl(request);
    resolve(new Uint8Array([1]));
    const urls = await Promise.all([first, second]);
    assert.equal(urls[0], urls[1]);
    assert.equal(revoked.includes(urls[0]), false, 'the displayed URL must remain valid');
    loader.dispose();
    loader.dispose();
    assert.deepEqual([...revoked].sort(), [...created].sort(), 'every created URL is revoked exactly once');
    const closing = createConsultationMediaLoader({ readAsset: () => data });
    const pending = closing.loadImageUrl(request);
    closing.dispose();
    assert.equal(await pending, null);
    assert.equal(created.length, 2, 'no URL is created after disposal');
  } finally {
    Object.assign(URL, original);
    await server.close();
  }
});

const ids = new Map();
const mediaId = (reference) => {
  if (!ids.has(reference)) ids.set(reference, `m-opaque-${ids.size + 1}`);
  return ids.get(reference);
};
function consultationStory(story) {
  const copy = structuredClone(story);
  for (const node of copy.stageNodes) for (const slot of ['audio', 'image']) {
    if (typeof node[slot] === 'string' && node[slot].trim()) node[slot] = mediaId(node[slot]);
  }
  return copy;
}
const structure = (graph) => ({
  entryId: graph.entryId,
  title: graph.title,
  readiness: graph.readiness,
  actions: [...graph.actions.entries()],
  stages: [...graph.stages.entries()].map(([id, stage]) => [id, { ...stage, audio: Boolean(stage.audio), image: Boolean(stage.image) }]),
});

test('a pack consultation plays the graph of the existing pack reader', () => {
  const reference = packFlatGraph(fixture.story, '/Packs/Lune.zip');
  const handle = { consultationId: 'token', kind: 'pack', graph: consultationStory(fixture.story) };
  const graph = consultationFlatGraph(handle);
  assert.deepEqual(structure(graph), structure(reference));
  for (const [id, stage] of reference.stages) {
    for (const slot of ['audio', 'image']) {
      const before = stage[slot];
      const after = graph.stages.get(id)[slot];
      if (!before) { assert.equal(after, null); continue; }
      assert.equal(before.kind, MEDIA_FROM_PACK);
      assert.deepEqual(after, { kind: MEDIA_FROM_CONSULTATION, assetRef: mediaId(before.assetRef), consultationId: 'token', mediaId: mediaId(before.assetRef) });
      assert.equal(mediaRequestKey(after), `consultation:token:${mediaId(before.assetRef)}`);
    }
  }
});

test('a graph project consultation plays the document view with its bindings', () => {
  const controls = { presence: 'value', complete: true, ...Object.fromEntries(['wheel', 'ok', 'home', 'pause', 'autoplay'].map((key) => [key, presence(key !== 'pause' && key !== 'autoplay')])) };
  const view = {
    entry: { status: 'unique', stagePath: '/s/1' },
    metadata: { title: presence('Graphe') },
    stages: [
      { path: '/s/1', uuid: 'u1', name: presence('Départ'), squareOne: presence(true), controls, audio: { presence: 'value', assetRef: 'voix' }, image: { presence: 'value', assetRef: 'sans-fichier' }, okTransition: presence(null), homeTransition: presence(null) },
    ],
    actions: [],
  };
  const project = { authoring: { mediaBindings: [{ assetRef: 'voix', path: '/Projets/voix.mp3' }] } };
  const reference = documentFlatGraph(view, project);
  const graph = consultationFlatGraph({ consultationId: 'token', kind: 'document', graph: { view, media: { voix: 'm-1', 'sans-fichier': null } } });
  assert.deepEqual(structure(graph), structure(reference));
  assert.deepEqual(graph.stages.get('/s/1').audio, { kind: MEDIA_FROM_CONSULTATION, assetRef: 'm-1', consultationId: 'token', mediaId: 'm-1' });
  assert.equal(graph.stages.get('/s/1').image, null);
  assert.equal(graph.readiness.unresolvedMedia, reference.readiness.unresolvedMedia);
  assert.equal(consultationFlatGraph(null), null);
});

test('consultation media: own URL cache, typed bytes, expiry reported, shared cache untouched', async () => {
  const server = await createServer({ configFile: false, plugins: [react()], server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const created = [];
  const revoked = [];
  const urls = { createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
  URL.createObjectURL = (blob) => { const url = `blob:test/${created.length}`; created.push({ url, type: blob.type }); return url; };
  URL.revokeObjectURL = (url) => { revoked.push(url); };
  try {
    const { createConsultationMediaLoader, createFlatAudio } = await server.ssrLoadModule('/src/tabs/EmulatorTab/flatMedia.js');
    const failures = [];
    const reads = [];
    const loader = createConsultationMediaLoader({
      mediaTypes: { 'm-1': 'image/png', 'm-2': 'audio/mpeg' },
      readAsset: async (request) => {
        reads.push(request.mediaId);
        if (request.mediaId === 'm-3') throw { code: 'CATALOG_CONSULTATION_EXPIRED' };
        return new Uint8Array([1]);
      },
      onFailure: (error) => failures.push(error.code),
    });
    const image = { kind: MEDIA_FROM_CONSULTATION, consultationId: 't', mediaId: 'm-1' };
    const url = await loader.loadImageUrl(image);
    assert.equal(await loader.loadImageUrl(image), url, 'cached for this consultation');
    assert.deepEqual(created, [{ url, type: 'image/png' }]);
    const audio = await loader.loadAudio({ kind: MEDIA_FROM_CONSULTATION, consultationId: 't', mediaId: 'm-2' });
    assert.deepEqual([audio.kind, audio.mime, [...audio.bytes]], [MEDIA_FROM_CONSULTATION, 'audio/mpeg', [1]]);
    assert.equal(createFlatAudio({ kind: MEDIA_FROM_CONSULTATION, mime: 'audio/mpeg', bytes: null }), null, 'a refused media plays silent');
    assert.equal(await loader.loadImageUrl({ kind: MEDIA_FROM_CONSULTATION, consultationId: 't', mediaId: 'm-3' }), null);
    assert.deepEqual(failures, ['CATALOG_CONSULTATION_EXPIRED']);
    loader.dispose();
    assert.deepEqual(revoked, [url], 'only its own URL is revoked');
    assert.equal(await loader.loadImageUrl({ ...image, mediaId: 'm-9' }), null, 'nothing is read after closing');
    assert.deepEqual(reads, ['m-1', 'm-2', 'm-3']);
  } finally {
    Object.assign(URL, urls);
    await server.close();
  }
});
