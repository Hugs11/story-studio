import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGraphCopy,
  graphCopyFileName,
  graphCopyProject,
  graphCopyRustExport,
  nextGraphCopyPath,
} from '../src/store/graphCopy.js';
import {
  createGraphCopyFlow,
  GRAPH_COPY_TITLE,
  SAVE_ORIGINAL_FIRST,
} from '../src/hooks/graphCopyFlow.js';
import { createAdvancedProject } from '../src/store/projectModel/authoring.js';
import { normalizeWorkProject } from '../src/store/projectWorkState.js';

const EDGE = { leading: 0.4, trailing: 0.4 };

function freeProject(overrides = {}) {
  return normalizeWorkProject({
    projectType: 'pack',
    projectName: 'Toudou',
    rootAudio: 'C:/travail/accueil.mp3',
    rootImage: 'C:/travail/accueil.png',
    packMetadata: {
      title: 'Toudou',
      uuid: '000bbd53-c14d-4d0e-93e8-2c9b2bf51a05',
      version: 3,
      namingMode: 'convention',
      minAge: '3',
      author: 'Hugs',
    },
    rootEntries: [],
    globalOptions: { autoNext: false, nightMode: false, silenceMode: 'add', harmonizeLoudness: false },
    ...overrides,
  });
}

const graphPayload = JSON.stringify({ payloadVersion: 1, document: {}, context: {} });
const graphProject = createAdvancedProject({ payload: graphPayload, projectName: 'Graphe' });

// ── Nom de la copie ─────────────────────────────────────────────────────────

test('la copie s’appelle « nom - graphe.mbah », à côté de l’original', async () => {
  assert.equal(graphCopyFileName('C:\\projets\\Toudou.mbah'), 'Toudou - graphe.mbah');
  assert.equal(graphCopyFileName('/home/hugs/Toudou.mbah', 3), 'Toudou - graphe (3).mbah');
  const path = await nextGraphCopyPath('C:\\projets\\Toudou.mbah', async () => false);
  assert.equal(path, 'C:\\projets\\Toudou - graphe.mbah');
});

test('un nom déjà pris passe au suivant, sans jamais écraser', async () => {
  const taken = new Set([
    '/projets/Léo la licorne - graphe.mbah',
    '/projets/Léo la licorne - graphe (2).mbah',
  ]);
  const asked = [];
  const path = await nextGraphCopyPath('/projets/Léo la licorne.mbah', async (candidate) => {
    asked.push(candidate);
    return taken.has(candidate);
  });
  assert.equal(path, '/projets/Léo la licorne - graphe (3).mbah');
  assert.equal(asked.length, 3);
});

// ── Ce que la copie reprend ─────────────────────────────────────────────────

test('la copie garde le nommage d’archive, la vignette et les réglages audio', () => {
  const original = freeProject({ thumbnailImage: 'C:/travail/vignette.png' });
  const copy = graphCopyProject(original, { payload: graphPayload, mediaBindings: [] });
  assert.equal(copy.authoringMode, 'advanced');
  assert.equal(copy.projectName, 'Toudou');
  assert.equal(copy.thumbnailImage, original.thumbnailImage);
  assert.ok(copy.thumbnailImage);
  assert.equal(copy.packMetadata.namingMode, 'convention');
  assert.equal(copy.packMetadata.minAge, '3');
  assert.equal(copy.packMetadata.author, 'Hugs');
  assert.deepEqual(copy.globalOptions, { silenceMode: 'add', harmonizeLoudness: false });
});

test('« même image » côté arbre devient l’absence de vignette propre côté graphe', () => {
  const original = freeProject({ sameImage: true, thumbnailImage: 'C:/travail/accueil.png' });
  const copy = graphCopyProject(original, { payload: graphPayload, mediaBindings: [] });
  assert.equal(copy.thumbnailImage, undefined);
});

test('le moteur reçoit le titre de la fiche, pas le nom d’archive composé', () => {
  const exported = graphCopyRustExport(freeProject(), EDGE);
  assert.equal(exported.name, 'Toudou');
  assert.equal(exported.packUuid, '000bbd53-c14d-4d0e-93e8-2c9b2bf51a05');
});

// ── Copie complète : la garde passe avant tout ──────────────────────────────

function engine({ refuseVerify = false } = {}) {
  const calls = [];
  const invokeCommand = async (command, args) => {
    calls.push(command);
    if (command === 'copy_project_to_graph') return { payload: graphPayload, mediaBindings: [] };
    if (command === 'read_advanced_graph_view') return { stages: [], actions: [], edges: [] };
    if (command === 'verify_project_graph_copy') {
      assert.equal(args.payload, graphPayload);
      if (refuseVerify) throw 'La copie graphe ne produirait pas exactement le même pack que ton projet.';
      return null;
    }
    throw new Error(`commande inattendue : ${command}`);
  };
  return { calls, invokeCommand };
}

test('la garde de fidélité juge le payload final, après la disposition', async () => {
  const { calls, invokeCommand } = engine();
  const copy = await buildGraphCopy(freeProject(), { audioEdgeSilence: EDGE, invokeCommand });
  assert.equal(copy.authoring.payload, graphPayload);
  assert.deepEqual(calls, ['copy_project_to_graph', 'read_advanced_graph_view', 'verify_project_graph_copy']);
});

test('un refus de la garde fait échouer la copie', async () => {
  const { invokeCommand } = engine({ refuseVerify: true });
  await assert.rejects(
    buildGraphCopy(freeProject(), { audioEdgeSilence: EDGE, invokeCommand }),
    /pas exactement le même pack/,
  );
});

// ── Déroulé ─────────────────────────────────────────────────────────────────

function flow({
  project = freeProject(),
  savePath = 'C:/projets/Toudou.mbah',
  answers = [],
  saveResult = 'C:/projets/Toudou.mbah',
  leave = true,
  buildCopy = async () => graphProject,
  existing = [],
} = {}) {
  const log = { dialogs: [], writes: [], opened: [], errors: [], saves: 0 };
  let currentPath = savePath;
  const queue = [...answers];
  const deps = {
    currentProject: () => project,
    currentSavePath: () => currentPath,
    saveOriginal: async () => {
      log.saves += 1;
      currentPath = saveResult;
      return saveResult;
    },
    confirmLeaveOriginal: async () => leave,
    choose: async (dialog) => {
      log.dialogs.push(dialog.message);
      return queue.shift() ?? null;
    },
    showError: (dialog) => log.errors.push(dialog.message),
    fileExists: async (path) => existing.includes(path),
    buildCopy,
    writeNewFile: async (_copy, path) => { log.writes.push(path); },
    openCopy: async (path) => { log.opened.push(path); },
  };
  return { log, run: createGraphCopyFlow(deps) };
}

test('depuis l’éditeur par menus : avertissement, copie écrite à côté, puis ouverte', async () => {
  const { log, run } = flow({ answers: ['copy'] });
  assert.equal(await run.continueInGraph(), true);
  assert.equal(log.dialogs.length, 1);
  assert.match(log.dialogs[0], /« Toudou - graphe\.mbah »/);
  assert.match(log.dialogs[0], /Ton projet reste tel quel/);
  assert.deepEqual(log.writes, ['C:/projets/Toudou - graphe.mbah']);
  assert.deepEqual(log.opened, ['C:/projets/Toudou - graphe.mbah']);
});

test('un projet jamais enregistré est d’abord enregistré, et la copie se crée à côté', async () => {
  const { log, run } = flow({ savePath: null, answers: ['save', 'copy'] });
  assert.equal(await run.continueInGraph(), true);
  assert.equal(log.dialogs[0], SAVE_ORIGINAL_FIRST);
  assert.equal(log.saves, 1);
  assert.deepEqual(log.writes, ['C:/projets/Toudou - graphe.mbah']);
});

test('refuser d’enregistrer un projet jamais enregistré n’écrit rien', async () => {
  const { log, run } = flow({ savePath: null, answers: [null] });
  assert.equal(await run.continueInGraph(), false);
  assert.equal(log.saves, 0);
  assert.deepEqual(log.writes, []);
});

test('annuler l’avertissement ou la question de l’original n’écrit rien', async () => {
  const cancelled = flow({ answers: [null] });
  assert.equal(await cancelled.run.continueInGraph(), false);
  assert.deepEqual(cancelled.log.writes, []);

  const kept = flow({ answers: ['copy'], leave: false });
  assert.equal(await kept.run.continueInGraph(), false);
  assert.deepEqual(kept.log.writes, []);
});

test('un refus de conversion est dit, et rien n’est écrit', async () => {
  const { log, run } = flow({
    answers: ['copy'],
    buildCopy: async () => { throw new Error('Ton projet contient un pack inclus.'); },
  });
  assert.equal(await run.continueInGraph(), false);
  assert.deepEqual(log.writes, []);
  assert.deepEqual(log.opened, []);
  assert.deepEqual(log.errors, ['Ton projet contient un pack inclus.']);
});

test('une copie déjà présente n’est jamais écrasée : la suivante prend (2)', async () => {
  const { log, run } = flow({ answers: ['copy'], existing: ['C:/projets/Toudou - graphe.mbah'] });
  await run.continueInGraph();
  assert.deepEqual(log.writes, ['C:/projets/Toudou - graphe (2).mbah']);
});

test('depuis le graphe, ouvrir un projet par menus propose la copie au lieu de changer d’éditeur', async () => {
  const { log, run } = flow({ project: graphProject, answers: ['copy'] });
  const handled = await run.routeLoadedProject({ path: 'C:/projets/Azuro.mbah', data: freeProject() });
  assert.equal(handled, true);
  assert.deepEqual(log.writes, ['C:/projets/Azuro - graphe.mbah']);
  assert.deepEqual(log.opened, ['C:/projets/Azuro - graphe.mbah']);
});

test('depuis le graphe, annuler la copie laisse le graphe ouvert, sans rien écrire', async () => {
  const { log, run } = flow({ project: graphProject, answers: [null] });
  const handled = await run.routeLoadedProject({ path: 'C:/projets/Azuro.mbah', data: freeProject() });
  assert.equal(handled, true, 'le projet par menus ne remplace pas le graphe');
  assert.deepEqual(log.writes, []);
});

test('hors de ce cas, l’ouverture de projet reste celle d’avant', async () => {
  const fromFree = flow();
  assert.equal(await fromFree.run.routeLoadedProject({ path: 'C:/a.mbah', data: freeProject() }), false);
  const graphFromGraph = flow({ project: graphProject });
  assert.equal(await graphFromGraph.run.routeLoadedProject({ path: 'C:/b.mbah', data: graphProject }), false);
  assert.deepEqual(fromFree.log.dialogs, []);
  assert.deepEqual(graphFromGraph.log.dialogs, []);
});

test('le titre des dialogues est celui de la commande', () => {
  assert.equal(GRAPH_COPY_TITLE, 'Continuer dans l’éditeur graphe');
});
