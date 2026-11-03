import test from 'node:test';
import assert from 'node:assert/strict';
import { register, registerHooks } from 'node:module';
import { runner } from './reactHookDriver.mjs';

// Vrais store, session d'auteur et hook des exemples. Doublés : contexte projet
// (réglages TTS, file IA), écriture de l'image-titre, suppression de fichier,
// et le service des voix Piper (`piper_list_voices` / `piper_ensure_voice`).
// Aucun modèle ni voix n'est téléchargé.
const doubles = new Map([
  ['../store/ProjectContext', 'export const useProjectContext = () => globalThis.__voice.context;'],
  ['../components/TextImageGenerator/generateTextImage',
    'export const generateTextImage = (...args) => globalThis.__voice.generateTextImage(...args);'],
  ['@tauri-apps/plugin-fs', 'export const remove = async () => {};'],
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
const { default: i18next } = await import('i18next');
const { createTestI18n } = await import('./i18nTestSetup.mjs');
i18next.init(createTestI18n().options);
const { useProjectStore } = await import('../src/store/projectStore.js');
const { useAdvancedAuthoring } = await import('../src/hooks/useAdvancedAuthoring.js');
const { useAdvancedExamples } = await import('../src/hooks/useAdvancedExamples.js');
const { createAdvancedProject, readAuthoringPayload } = await import('../src/store/projectModel/authoring.js');
const { createAdvancedExample } = await import('../src/store/advancedExamples/catalog.js');

const tick = () => new Promise((resolve) => setImmediate(resolve));
const readDocument = (project) => JSON.parse(readAuthoringPayload(project)).document;
function withDocument(project, update) {
  const payload = JSON.parse(readAuthoringPayload(project));
  payload.document = update(payload.document);
  return { ...project, authoring: { ...project.authoring, payload: JSON.stringify(payload) } };
}
const CATALOGUE = [
  { id: 'fr_FR-siwis-medium', language: 'fr_FR', installed: true },
  { id: 'en_US-kristin-medium', language: 'en_US', installed: false },
  { id: 'it_IT-serena-medium', language: 'it_IT', installed: true },
];

function harness({ settings, voices = CATALOGUE, ensure = async () => {}, gateImages = false } = {}) {
  const jobs = [];
  const calls = { list: 0, ensure: [] };
  const imageGates = [];
  const xttsSettings = Object.freeze(structuredClone(settings));
  globalThis.__voice = {
    context: { xttsSettings, workspaceDir: '/espace', savePath: null, onQueueXttsGenerate: (job) => { jobs.push(job); } },
    async generateTextImage(text) {
      if (gateImages) await new Promise((resolve) => { imageGates.push(resolve); });
      return `/espace/${encodeURIComponent(text)}.png`;
    },
  };
  const service = {
    list: async () => { calls.list += 1; return structuredClone(voices); },
    ensure: async (voice) => { calls.ensure.push(voice); return ensure(voice); },
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
          stageNodes: [...document.stageNodes, ...stages.map((uuid, rank) => ({ uuid, name: gesture.subgraph.stages[rank].name, media: {} }))],
          actionNodes: [...document.actionNodes, ...actions.map((id, rank) => ({ id, name: gesture.subgraph.actions[rank].name }))],
        })),
        report: { gesture: 'paste-subgraph', construction: { stages, actions } },
      };
    }
    if (gesture.gesture === 'set-stage-media') {
      return {
        project: withDocument(project, (document) => ({
          ...document,
          stageNodes: document.stageNodes.map((stage) => (stage.uuid === gesture.stageUuid
            ? { ...stage, media: { ...stage.media, [gesture.kind]: gesture.path } } : stage)),
        })),
        report: { gesture: 'set-stage-media' },
      };
    }
    throw new Error(`geste inattendu ${gesture.gesture}`);
  };
  const readView = async () => ({ stages: [{ uuid: 'auteur', layout: { x: 0, y: 0 } }], actions: [] });
  const live = {};
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
    const examples = useAdvancedExamples({ authoring, projectEpoch: store.workEpochRef.current, onAssignMedia, onInserted: () => {}, voices: service });
    Object.assign(live, { store, authoring, examples });
    return live;
  });
  app.render(); app.flush();
  live.store.loadProject(createAdvancedProject({
    payload: JSON.stringify({ payloadVersion: 1, document: { stageNodes: [{ uuid: 'auteur', name: 'Mon Écran', media: {} }], actionNodes: [] } }),
  }));
  const render = () => { app.render(); app.flush(); return live; };
  render();
  const settle = async () => { for (let i = 0; i < 40; i += 1) { await tick(); render(); } };
  const stages = () => readDocument(live.store.project).stageNodes;
  return { live, render, settle, jobs, calls, stages, imageGates, xttsSettings };
}

test('voix absente : aucun téléchargement sans choix, échec hors ligne propre, « Générer sans audio » toujours possible', async () => {
  const offline = { code: 'PIPER_DOWNLOAD_REQUEST_FAILED', params: { service: 'huggingface.co', error: 'offline' }, detail: '_RAW_OFFLINE_' };
  const h = harness({ settings: { backend: 'piper', piperVoice: 'fr_FR-siwis-medium' }, ensure: async () => { throw offline; } });
  const example = createAdvancedExample('garden-quiz', 'en');
  h.live.examples.open(example); h.render(); await h.settle();
  assert.equal(h.calls.list, 1, 'lecture locale du catalogue à l’ouverture');
  assert.deepEqual(h.live.examples.state.voice, { backend: 'piper', language: 'en', voice: 'en_US-kristin-medium', adapted: true, status: 'missing' });
  await h.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } }); h.render();
  assert.equal(h.live.examples.state.voiceChoice, true, 'le dialogue propose Installer / Générer sans audio');
  assert.deepEqual(h.calls.ensure, [], 'aucun téléchargement silencieux');
  assert.equal(h.stages().length, 1, 'rien n’est inséré avant le choix');
  await h.live.examples.confirm({ images: false, audios: true, installVoice: true, anchor: { x: 0, y: 0 } }); h.render();
  assert.deepEqual(h.calls.ensure, ['en_US-kristin-medium']);
  assert.equal(h.live.examples.state.voiceError, offline, 'cause IPC conservée pour le présentateur');
  assert.equal(h.live.examples.state.voiceChoice, true, 'le choix reste disponible hors ligne');
  assert.equal(h.live.examples.state.busy, false);
  assert.equal(h.stages().length, 1);
  await h.live.examples.confirm({ images: false, audios: false, anchor: { x: 0, y: 0 } }); h.render(); await h.settle();
  assert.equal(h.live.examples.state.inserted, true);
  assert.equal(h.jobs.length, 0, 'aucun audio demandé');
  assert.deepEqual(h.calls.ensure, ['en_US-kristin-medium'], 'une seule tentative, demandée explicitement');
  assert.equal(h.stages().length, 1 + example.stages.length);
  assert.ok(h.stages().slice(1).every((stage, rank) => stage.name === example.stages[rank].name), 'noms anglais capturés au choix');
  assert.deepEqual(h.xttsSettings, { backend: 'piper', piperVoice: 'fr_FR-siwis-medium' }, 'préférences TTS intactes');
});

test('voix installée à la demande : requêtes dans la langue de l’exemple, figées malgré le changement de langue', async () => {
  const h = harness({ settings: { backend: 'piper', piperVoice: 'fr_FR-siwis-medium' }, gateImages: true });
  const example = createAdvancedExample('castle-quiz', 'en');
  h.live.examples.open(example); h.render(); await h.settle();
  await h.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } }); h.render();
  const pending = h.live.examples.confirm({ images: true, audios: true, installVoice: true, anchor: { x: 0, y: 0 } });
  while (h.imageGates.length === 0) { await tick(); h.render(); }
  // L'interface passe en italien pendant la génération : rien ne change dans l'exemple.
  await i18next.changeLanguage('it');
  while (h.imageGates.length) { h.imageGates.shift()(); await tick(); h.render(); for (let i = 0; i < 5 && !h.imageGates.length; i += 1) await tick(); }
  await pending; await h.settle();
  assert.deepEqual(h.calls.ensure, ['en_US-kristin-medium']);
  const plan = example.stages.filter((stage) => stage.mediaIntent.audio);
  assert.equal(h.jobs.length, plan.length);
  h.jobs.forEach((job, rank) => {
    assert.equal(job.request.voice, 'en_US-kristin-medium');
    assert.equal(job.request.language, 'en');
    assert.equal(job.request.text, plan[rank].name);
    assert.equal(job.voiceLabel, 'en_US-kristin-medium');
  });
  assert.deepEqual(h.xttsSettings, { backend: 'piper', piperVoice: 'fr_FR-siwis-medium' });
  assert.equal(h.live.examples.state.result.audioCount, plan.length);
  await i18next.changeLanguage('fr');
});

test('voix compatible conservée, XTTS dans la langue de l’exemple, XTTS absent sans audio', async () => {
  const italian = harness({ settings: { backend: 'piper', piperVoice: 'it_IT-serena-medium' } });
  italian.live.examples.open(createAdvancedExample('lighthouse', 'it')); italian.render(); await italian.settle();
  assert.equal(italian.live.examples.state.voice.adapted, false);
  await italian.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } }); await italian.settle();
  assert.ok(italian.jobs.length > 0);
  assert.ok(italian.jobs.every((job) => job.request.voice === 'it_IT-serena-medium' && job.request.language === 'it'));
  assert.deepEqual(italian.calls.ensure, []);

  const xtts = harness({ settings: { backend: 'xtts', enabled: true, language: 'fr', favoriteVoices: ['Mamie'] } });
  xtts.live.examples.open(createAdvancedExample('grey-rabbit', 'it')); xtts.render(); await xtts.settle();
  await xtts.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } }); await xtts.settle();
  assert.ok(xtts.jobs.length > 0);
  assert.ok(xtts.jobs.every((job) => job.request.voice === 'Mamie' && job.request.language === 'it'), 'langue de l’exemple, pas celle des préférences XTTS');
  assert.deepEqual(xtts.calls.ensure, []);

  const absent = harness({ settings: { backend: 'xtts', enabled: false, favoriteVoices: ['Mamie'] } });
  absent.live.examples.open(createAdvancedExample('explorer-train', 'en')); absent.render(); await absent.settle();
  assert.equal(absent.live.examples.state.voice.status, 'unavailable');
  await absent.live.examples.confirm({ images: false, audios: true, anchor: { x: 0, y: 0 } }); absent.render();
  assert.deepEqual(absent.live.examples.state.error, { key: 'examples:error.voice.required' });
  assert.equal(absent.stages().length, 1);
  await absent.live.examples.confirm({ images: false, audios: false, anchor: { x: 0, y: 0 } }); await absent.settle();
  assert.equal(absent.live.examples.state.inserted, true);
  assert.equal(absent.jobs.length, 0);
});

test('cinq exemples × médias activés/désactivés : topologie identique, noms capturés, aucun nom d’auteur réécrit', async () => {
  for (const id of ['garden-quiz', 'castle-quiz', 'grey-rabbit', 'lighthouse', 'explorer-train']) {
    for (const language of ['fr', 'en', 'it']) {
      for (const [images, audios] of [[true, true], [false, false]]) {
        const h = harness({ settings: { backend: 'piper', piperVoice: `${language === 'en' ? 'en_US-kristin' : language === 'it' ? 'it_IT-serena' : 'fr_FR-siwis'}-medium` },
          voices: CATALOGUE.map((voice) => ({ ...voice, installed: true })) });
        const example = createAdvancedExample(id, language);
        h.live.examples.open(example); h.render(); await h.settle();
        await h.live.examples.confirm({ images, audios, anchor: { x: 0, y: 0 } }); await h.settle();
        const stages = h.stages();
        assert.equal(stages[0].name, 'Mon Écran', 'le nom d’auteur existant n’est pas réécrit');
        assert.deepEqual(stages.slice(1).map((stage) => stage.name), example.stages.map((stage) => stage.name));
        const plan = example.stages.filter((stage) => stage.mediaIntent.audio).length;
        assert.equal(h.jobs.length, audios ? plan : 0, `${id}/${language}`);
        assert.equal(h.live.examples.state.result.imageCount, images ? example.stages.filter((stage) => stage.mediaIntent.image).length : 0);
      }
    }
  }
});
