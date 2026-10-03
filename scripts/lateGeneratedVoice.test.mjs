// Voix Piper/XTTS demandée pour le projet A, arrivée après l'ouverture de B.
//
// Store, file de voix, dispatch (`useAiGeneration`) et exécuteur (`useXttsJobs`)
// intacts ; seuls l'ordonnanceur React et la réponse native sont doublés, la
// réponse étant retenue jusqu'après `loadProject(B)`.
//
// Attendu, pour chaque cible menus/simple (`root`, `rootStory`, `newStory`) et
// chaque moteur : B reste inchangé, la voix reste disponible comme résultat du
// job. Contre-épreuve : sans changement de projet, la voix est bien appliquée.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useXttsStore } = await import('../src/store/xttsStore.js');
const { useAiGeneration } = await import('../src/hooks/useAiGeneration.js');
const { useXttsJobs } = await import('../src/hooks/useXttsJobs.js');
const { normalizeProjectData, buildProjectIndex } = await import('../src/store/projectModel.js');

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const noop = () => {};

const TARGETS = {
  root: { kind: 'root', field: 'rootAudio' },
  rootStory: { kind: 'rootStory' },
  newStory: { kind: 'newStory', menuId: null },
};

function project(name, projectType) {
  return normalizeProjectData({
    projectType,
    projectName: name,
    rootAudio: `C:/medias/${name}-accueil.wav`,
    rootEntries: [{ id: name, type: 'story', name, audio: `C:/medias/${name}.wav` }],
  });
}

async function runVoice({ kind, backend, switchProject }) {
  const projectType = kind === 'rootStory' ? 'simple' : 'pack';
  let reply;
  const nativeReply = new Promise((resolve) => { reply = resolve; });
  const commands = [];
  const previousInvoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (command) => {
    commands.push(command);
    if (command === 'piper_generate_audio' || command === 'xtts_generate_audio') return nativeReply;
    throw new Error(`commande non doublée : ${command}`);
  };
  try {
    let store; let xtts; let ai;
    const app = runner(() => {
      store = useProjectStore();
      xtts = useXttsStore();
      ai = useAiGeneration({
        store,
        sdStore: {},
        xttsStore: xtts,
        projectIndex: buildProjectIndex(store.project),
        xttsSettings: { backend },
        setBottomPanelOpen: noop,
        setBottomPanelTab: noop,
      });
      useXttsJobs(xtts, ai.applyGeneratedAudioToTarget, 'C:/session');
      return store;
    });
    app.render();
    app.flush();
    store.loadProject(project('A', projectType));
    app.render();
    await ai.handleQueueXttsGenerate({ target: { ...TARGETS[kind] }, request: { text: 'Une voix. Suite.' } });
    app.render();
    app.flush(); // le job part : réponse native retenue
    app.render();
    if (switchProject) {
      store.loadProject(project('B', projectType));
      app.render();
    }
    const before = structuredClone(store.project);
    reply('C:/session/voix-generees/voix.wav');
    await settle();
    app.render();
    return { before, after: store.project, job: xtts.jobs[0], commands };
  } finally {
    window.__TAURI_INTERNALS__.invoke = previousInvoke;
  }
}

for (const kind of Object.keys(TARGETS)) {
  for (const backend of ['piper', 'xtts']) {
    test(`${kind} / ${backend} : une voix arrivée après l'ouverture d'un autre projet ne le modifie pas`, async () => {
      const { before, after, job, commands } = await runVoice({ kind, backend, switchProject: true });
      assert.ok(commands.includes(backend === 'piper' ? 'piper_generate_audio' : 'xtts_generate_audio'));
      assert.equal(after.projectName, 'B');
      assert.deepEqual(after, before, 'le projet B reste inchangé');
      assert.equal(job.status, 'done');
      assert.match(job.resultPath, /voix-generees.voix\.wav$/, 'le fichier produit reste disponible');
    });
  }

  test(`${kind} : sans changement de projet, la voix est appliquée`, async () => {
    const { before, after } = await runVoice({ kind, backend: 'piper', switchProject: false });
    assert.notDeepEqual(after, before);
    assert.ok(JSON.stringify(after).includes('voix.wav'));
  });
}
