import test from 'node:test';
import assert from 'node:assert/strict';
import { register, registerHooks } from 'node:module';
import { runner } from './reactHookDriver.mjs';

// Le store, la session d'auteur et le hook des exemples sont ceux de
// production. Seuls sont doublés : le contexte projet (TTS, file IA), l'écriture
// de l'image-titre et la suppression de fichier, et le codec natif des gestes.
const doubles = new Map([
  ['../store/ProjectContext', 'export const useProjectContext = () => globalThis.__examples.context;'],
  ['../components/TextImageGenerator/generateTextImage',
    'export const generateTextImage = (...args) => globalThis.__examples.generateTextImage(...args);'],
  ['@tauri-apps/plugin-fs', 'export const remove = (path) => globalThis.__examples.remove(path);'],
]);
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/src/hooks/useAdvancedExamples.js') && doubles.has(specifier)) {
      return { url: `data:text/javascript,${encodeURIComponent(doubles.get(specifier))}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});
register('./nodeSourceResolver.mjs', import.meta.url);
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useAdvancedAuthoring } = await import('../src/hooks/useAdvancedAuthoring.js');
const { useAdvancedExamples } = await import('../src/hooks/useAdvancedExamples.js');
const { createAdvancedProject, readAuthoringPayload } = await import('../src/store/projectModel/authoring.js');

const controls = { wheel: false, ok: true, home: true, pause: false, autoplay: false };
const example = {
  id: 'hook', title: 'Exemple éprouvé', description: '', entryRank: 0,
  stages: [
    { name: 'Le départ', controls, offset: { x: 0, y: 0 }, mediaIntent: { image: true, audio: true } },
    { name: 'La forêt', controls, offset: { x: 300, y: 0 }, mediaIntent: { image: true, audio: false } },
    { name: 'La rivière', controls, offset: { x: 600, y: 0 }, mediaIntent: { image: true, audio: true } },
  ],
  actions: [{ name: 'Choisir', options: [], offset: { x: 300, y: 300 } }],
  transitions: [],
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

const readDocument = (project) => JSON.parse(readAuthoringPayload(project)).document;
function withDocument(project, update) {
  const payload = JSON.parse(readAuthoringPayload(project));
  payload.document = update(payload.document);
  return { ...project, authoring: { ...project.authoring, payload: JSON.stringify(payload) } };
}

function harness({ gateImages = false } = {}) {
  const files = { written: [], removed: [] };
  const jobs = [];
  const created = [];
  const imageGates = [];
  globalThis.__examples = {
    context: {
      xttsSettings: { backend: 'piper', piperVoice: 'fr_FR-test' }, workspaceDir: '/espace',
      savePath: null, onMediaCreated: (path) => created.push(path),
      onQueueXttsGenerate: (job) => { jobs.push(job); },
    },
    async generateTextImage(text, workspaceDir, { filename }) {
      assert.equal(workspaceDir, '/espace');
      assert.match(filename, /^exemple-[0-9a-f-]{36}\.png$/);
      if (gateImages) await new Promise((resolve) => { imageGates.push(resolve); });
      const path = `/espace/images-generees/${filename}`;
      files.written.push(path);
      return path;
    },
    async remove(path) { files.removed.push(path); },
  };
  let counter = 0;
  const applyGesture = async (project, gesture) => {
    await tick();
    if (gesture.gesture === 'paste-subgraph') {
      const stages = gesture.subgraph.stages.map(() => `stage-${++counter}`);
      const actions = gesture.subgraph.actions.map(() => `action-${++counter}`);
      return {
        project: withDocument(project, (document) => ({
          ...document,
          stageNodes: [...document.stageNodes, ...stages.map((uuid) => ({ uuid, media: {} }))],
          actionNodes: [...document.actionNodes, ...actions.map((id) => ({ id }))],
        })),
        report: { gesture: 'paste-subgraph', construction: { stages, actions } },
      };
    }
    if (gesture.gesture === 'set-stage-media') {
      if (!readDocument(project).stageNodes.some((stage) => stage.uuid === gesture.stageUuid)) {
        throw Object.assign(new Error('Écran introuvable.'), { code: 'STAGE_NOT_FOUND' });
      }
      return {
        project: withDocument(project, (document) => ({
          ...document,
          stageNodes: document.stageNodes.map((stage) => (stage.uuid === gesture.stageUuid
            ? { ...stage, media: { ...stage.media, [gesture.kind]: gesture.path } } : stage)),
        })),
        report: { gesture: 'set-stage-media' },
      };
    }
    // Un geste quelconque de l'auteur.
    return { project: withDocument(project, (document) => ({ ...document, note: gesture.note })), report: {} };
  };
  // L'écran neuf porte déjà du contenu : l'exemple s'ajoute à côté.
  const readView = async () => ({ stages: [{ uuid: 'auteur', layout: { x: 0, y: 0 } }], actions: [] });
  const live = {};
  // Le même raccord que `assignStageMedia` de l'Éditeur graphe : relance au
  // repos quand un geste est déjà en vol, et `history` transmis tel quel.
  const onAssignMedia = async (stageUuid, kind, path, { history = true } = {}) => {
    const build = () => ({ gesture: 'set-stage-media', stageUuid, kind, path });
    let outcome = await live.authoring.runGestureFor('set-stage-media', build, { history });
    for (let attempt = 0; outcome?.status === 'busy' && attempt < 8; attempt += 1) {
      await live.authoring.whenIdle();
      outcome = await live.authoring.runGestureFor('set-stage-media', build, { history });
    }
    return outcome;
  };
  const app = runner(() => {
    const store = useProjectStore();
    const authoring = useAdvancedAuthoring({ store, applyGesture, readView });
    const examples = useAdvancedExamples({
      authoring, projectEpoch: store.workEpochRef.current, onAssignMedia, onInserted: () => {},
    });
    Object.assign(live, { store, authoring, examples });
    return live;
  });
  app.render();
  app.flush();
  live.store.loadProject(createAdvancedProject({
    payload: JSON.stringify({ payloadVersion: 1, document: { stageNodes: [{ uuid: 'auteur', media: {} }], actionNodes: [] } }),
  }));
  app.render();
  app.flush();
  const render = () => { app.render(); app.flush(); return live; };
  const settle = async () => {
    for (let i = 0; i < 40; i += 1) { await tick(); render(); }
  };
  const media = () => Object.fromEntries(readDocument(live.store.project).stageNodes.map((stage) => [stage.uuid, stage.media]));
  const undoSteps = () => {
    let steps = 0;
    while (live.store.canUndo) { live.store.undo(); render(); steps += 1; }
    return steps;
  };
  return { app, live, render, settle, files, jobs, created, imageGates, media, undoSteps };
}

test('insertion avec images et audios : un seul Ctrl+Z retire l’exemple entier', async () => {
  const h = harness();
  h.live.examples.open(example);
  h.render();
  await h.live.examples.confirm({ images: true, audios: true, anchor: { x: 0, y: 0 } });
  h.render();
  assert.equal(h.files.written.length, 3);
  assert.deepEqual(h.files.removed, []);
  assert.equal(h.jobs.length, 2, 'deux audios confiés à la file IA');
  // Les audios reviennent plus tard, sans autre geste de l'auteur entre-temps.
  for (const [rank, job] of h.jobs.entries()) {
    assert.equal((await job.target.apply(`/audio-${rank}.wav`)).status, 'applied');
    h.render();
  }
  const media = h.media();
  assert.deepEqual(media['stage-1'], { image: h.files.written[0], audio: '/audio-0.wav' });
  assert.deepEqual(media['stage-3'], { image: h.files.written[2], audio: '/audio-1.wav' });
  assert.deepEqual(h.created, h.files.written);
  h.live.store.undo();
  h.render();
  assert.deepEqual(Object.keys(h.media()), ['auteur'], 'un seul Ctrl+Z retire structure et médias');
  assert.equal(h.live.store.canUndo, false);
  // Rétablir rend l'exemple avec tous ses médias.
  h.live.store.redo();
  h.render();
  assert.deepEqual(h.media(), media);
});

test('un audio tardif après un geste de l’auteur devient une étape à part, sans corrompre l’historique', async () => {
  const h = harness();
  h.live.examples.open(example);
  h.render();
  await h.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } });
  h.render();
  assert.equal((await h.jobs[0].target.apply('/audio-0.wav')).status, 'applied');
  h.render();
  // L'auteur agit, puis le second audio arrive.
  assert.equal((await h.live.authoring.runGesture({ gesture: 'note', note: 'auteur' })).status, 'applied');
  h.render();
  assert.equal((await h.jobs[1].target.apply('/audio-1.wav')).status, 'applied');
  h.render();
  // Annuler : d'abord l'audio tardif, puis le geste de l'auteur, puis l'exemple
  // (avec l'audio arrivé avant le geste de l'auteur).
  h.live.store.undo(); h.render();
  assert.equal(h.media()['stage-3'].audio, undefined);
  assert.equal(readDocument(h.live.store.project).note, 'auteur');
  h.live.store.undo(); h.render();
  assert.equal(readDocument(h.live.store.project).note, undefined);
  assert.equal(h.media()['stage-1'].audio, '/audio-0.wav');
  h.live.store.undo(); h.render();
  assert.deepEqual(Object.keys(h.media()), ['auteur']);
  assert.equal(h.live.store.canUndo, false);
});

test('un audio arrivé avec un rétablissement en attente ne réécrit pas le redo', async () => {
  const h = harness();
  h.live.examples.open(example);
  h.render();
  await h.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } });
  h.render();
  await h.live.authoring.runGesture({ gesture: 'note', note: 'auteur' });
  h.render();
  h.live.store.undo(); h.render();
  // Le document est revenu exactement à celui de l'exemple, mais un redo attend.
  assert.equal((await h.jobs[0].target.apply('/audio-0.wav')).status, 'applied');
  h.render();
  assert.equal(h.live.store.canRedo, false, 'étape ordinaire : le redo est abandonné comme après tout geste');
  assert.equal(h.undoSteps(), 2, 'l’audio, puis l’exemple');
});

test('un audio qui revient après l’annulation de l’exemple est refusé et n’installe rien', async () => {
  const h = harness();
  h.live.examples.open(example);
  h.render();
  await h.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } });
  h.render();
  h.live.store.undo(); h.render();
  const before = h.live.store.project;
  assert.equal((await h.jobs[0].target.apply('/audio-0.wav')).status, 'refused');
  h.render();
  assert.equal(h.live.store.project, before);
  assert.equal(h.live.store.canRedo, true, 'l’exemple reste rétablissable');
});

test('double clic : une seule insertion et une seule génération', async () => {
  const h = harness();
  h.live.examples.open(example);
  h.render();
  const first = h.live.examples.confirm({ images: true, audios: false, anchor: { x: 0, y: 0 } });
  const second = h.live.examples.confirm({ images: true, audios: false, anchor: { x: 0, y: 0 } });
  await Promise.all([first, second]);
  h.render();
  assert.equal(readDocument(h.live.store.project).stageNodes.length, 4);
  assert.equal(h.files.written.length, 3);
  assert.equal(h.undoSteps(), 1);
});

test('« Arrêter les médias » : le graphe reste, l’image en cours est jetée, rien ne suit', async () => {
  const h = harness({ gateImages: true });
  h.live.examples.open(example);
  h.render();
  const pending = h.live.examples.confirm({ images: true, audios: true, anchor: { x: 0, y: 0 } });
  // Première image affectée, la seconde est en fabrication.
  while (h.imageGates.length === 0) { await tick(); h.render(); }
  h.imageGates.shift()();
  while (h.imageGates.length === 0) { await tick(); h.render(); }
  assert.equal(h.live.examples.state.busy, true);
  h.live.examples.stop();
  h.render();
  assert.equal(h.live.examples.state.busy, false, 'Fermer redevient possible');
  assert.equal(h.live.examples.state.stopped, true);
  h.imageGates.shift()();
  await pending;
  await h.settle();
  assert.equal(h.files.written.length, 2);
  assert.deepEqual(h.files.removed, [h.files.written[1]], 'l’image non affectée est supprimée');
  assert.equal(h.imageGates.length, 0, 'aucune image suivante');
  assert.equal(h.jobs.length, 0, 'aucun audio mis en file');
  const media = h.media();
  assert.deepEqual(media['stage-1'], { image: h.files.written[0] });
  assert.deepEqual(media['stage-2'], {});
  assert.equal(h.live.examples.state.result, null);
  h.live.examples.close();
  h.render();
  assert.equal(h.live.examples.state, null);
  assert.equal(h.undoSteps(), 1, 'l’exemple et sa première image partent ensemble');
});

test('changement de projet pendant la génération : aucune affectation, image jetée', async () => {
  const h = harness({ gateImages: true });
  h.live.examples.open(example);
  h.render();
  const pending = h.live.examples.confirm({ images: true, audios: true, anchor: { x: 0, y: 0 } });
  while (h.imageGates.length === 0) { await tick(); h.render(); }
  h.live.store.loadProject(createAdvancedProject({
    payload: JSON.stringify({ payloadVersion: 1, document: { stageNodes: [], actionNodes: [] } }),
  }));
  h.render();
  h.imageGates.shift()();
  await pending;
  await h.settle();
  assert.deepEqual(h.files.removed, h.files.written);
  assert.equal(h.live.examples.state, null);
  assert.deepEqual(readDocument(h.live.store.project).stageNodes, []);
  assert.equal(h.jobs.length, 0);
});

test('Fiche puis audio tardif : l’audio est une étape à part, annuler la Fiche le garde', async () => {
  const h = harness();
  h.live.examples.open(example);
  h.render();
  await h.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } });
  h.render();
  // Réglage de la Fiche : une étape d'undo hors document, révision d'auteur inchangée.
  h.live.store.setProject((project) => ({ ...project, globalOptions: { ...(project.globalOptions ?? {}), silenceMode: 'add' } }));
  h.render();
  assert.equal((await h.jobs[0].target.apply('/audio-0.wav')).status, 'applied');
  h.render();
  h.live.store.undo(); h.render();
  assert.equal(h.live.store.project.globalOptions?.silenceMode, 'add', 'le premier Ctrl+Z ne retire que l’audio');
  assert.equal(h.media()['stage-1'].audio, undefined);
  h.live.store.undo(); h.render();
  assert.equal(h.live.store.project.globalOptions?.silenceMode, undefined);
  assert.equal(readDocument(h.live.store.project).stageNodes.length, 4, 'l’exemple est encore là');
  h.live.store.undo(); h.render();
  assert.deepEqual(Object.keys(h.media()), ['auteur']);
  assert.equal(h.live.store.canUndo, false);
});

test('image affectée mais déclaration en échec : le fichier référencé n’est pas supprimé', async () => {
  const h = harness();
  globalThis.__examples.context.onMediaCreated = () => { throw new Error('Médiathèque indisponible'); };
  h.live.examples.open(example);
  h.render();
  await h.live.examples.confirm({ images: true, audios: false, anchor: { x: 0, y: 0 } });
  h.render();
  assert.deepEqual(h.files.removed, []);
  assert.equal(h.media()['stage-1'].image, h.files.written[0]);
  assert.deepEqual(h.live.examples.state.result.errors, []);
});
