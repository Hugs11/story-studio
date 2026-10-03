// Le travail graphe : ce qui est capturé, ce qui part, à qui le résultat
// appartient — et les deux verrous qui l'encadrent.
//
// Trois règles sont éprouvées ici —
//
// - les mutations d'auteur bloquées pendant la fabrication, les gestes déjà en
//   vol attendus, et **ensuite** seulement le document capturé ;
// - le retour de la commande, et lui seul, qui conclut ;
// - aucun résultat attribué à un projet que l'auteur a quitté.
//
// Les deux autres sont passées à la file, et sont éprouvées par
// `renderQueueTwoNatures.test.mjs` : un seul travail natif à la fois, et une
// annulation demandée avant le départ qui n'est jamais lancée.
//
// Tout est **pur** : la commande et la session d'édition sont des doubles.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GENERATION_OWNER_ADVANCED,
  GENERATION_OWNER_FREE,
  createNativeGenerationLock,
} from '../src/store/nativeGenerationLock.js';
import {
  ADVANCED_WORK,
  EXPORT_OWNERSHIP,
  prepareAdvancedWork,
  runAdvancedWork,
} from '../src/store/production/advancedRenderWork.js';
import {
  GESTURE_APPLIED,
  GESTURE_HELD,
  createAdvancedAuthoringSession,
} from '../src/store/advancedAuthoring/authoringSession.js';
import { readAuthoringRevision } from '../src/store/projectModel/authoringRevision.js';
import { exportRevisionToken } from '../src/store/advancedExport/exportRequest.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

function advancedProject(payload, bindings = []) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'pack',
    rootEntries: [],
    authoring: { payload, editorState: { version: 1 }, mediaBindings: bindings },
  };
}

const successResult = {
  zipPath: '/sorties/pack.zip',
  conversions: [],
  destinations: [],
  warnings: [],
  packIdentity: 'PACK-1',
  stageIdMap: {},
  assetNameMap: {},
  hasThumbnail: true,
};

// ── Le poste de travail natif ───────────────────────────────────────────────

test('le poste natif ne se tient qu’à un : la seconde prise est refusée', () => {
  const lock = createNativeGenerationLock();
  const first = lock.acquire({ owner: GENERATION_OWNER_FREE, label: 'pack A' });
  assert.ok(first);
  assert.equal(lock.holder.owner, GENERATION_OWNER_FREE);
  assert.equal(lock.acquire({ owner: GENERATION_OWNER_ADVANCED }), null);
  first.release();
  assert.equal(lock.holder, null);
  assert.ok(lock.acquire({ owner: GENERATION_OWNER_ADVANCED }));
});

test('une libération répétée ne relâche pas la prise du suivant', () => {
  const lock = createNativeGenerationLock();
  const first = lock.acquire({ owner: GENERATION_OWNER_FREE });
  first.release();
  const second = lock.acquire({ owner: GENERATION_OWNER_ADVANCED });
  // Un `finally` peut suivre une libération déjà faite ; il ne doit pas rendre
  // le poste que le suivant vient de prendre.
  first.release();
  assert.equal(lock.holder.owner, GENERATION_OWNER_ADVANCED);
  second.release();
  assert.equal(lock.holder, null);
});

test('la libération réveille les candidats en attente', () => {
  const lock = createNativeGenerationLock();
  const seen = [];
  const stop = lock.subscribe((holder) => seen.push(holder?.owner ?? null));
  const held = lock.acquire({ owner: GENERATION_OWNER_ADVANCED });
  held.release();
  stop();
  lock.acquire({ owner: GENERATION_OWNER_FREE });
  assert.deepEqual(seen, [GENERATION_OWNER_ADVANCED, null]);
});

// ── La capture : bloquer, attendre, puis seulement prendre ──────────────────

test("l'auteur est bloqué, les gestes en vol sont attendus, puis le document est capturé", async () => {
  const order = [];
  let payload = 'DOC-1';
  const settling = deferred();

  const prepared = prepareAdvancedWork({
    readProject: () => advancedProject(payload),
    readTicket: () => ({ projectEpoch: 7, document: readAuthoringRevision(advancedProject(payload)) }),
    readArchiveName: () => 'mon-pack',
    holdAuthoring: () => order.push('hold'),
    releaseAuthoring: () => order.push('release'),
    settleAuthoring: async () => { order.push('settle'); await settling.promise; },
    outputFolder: '/sorties',
    options: { silenceMode: 'add', harmonizeLoudness: true, leadingSilenceSec: 1.5 },
  });

  await Promise.resolve();
  // Un geste revenu pendant l'attente change le document : c'est **celui-là**
  // qui doit partir, pas celui d'avant la demande.
  payload = 'DOC-2';
  settling.resolve();

  const work = await prepared;
  assert.deepEqual(order, ['hold', 'settle']);
  assert.equal(work.outcome, ADVANCED_WORK.PREPARED);
  assert.equal(work.request.payload, 'DOC-2');
  assert.equal(work.request.outputFolder, '/sorties');
  assert.equal(work.request.archiveName, 'mon-pack');
  assert.equal(work.request.options.silenceMode, 'add');
  assert.equal(work.request.options.leadingSilenceSec, 1.5);
  assert.equal(work.request.options.harmonizeLoudness, true);
  assert.equal(work.epoch, 7);
  // La révision est celle de la **source d'export** : ce qui part réellement.
  assert.equal(work.revision, exportRevisionToken(advancedProject('DOC-2')));
});

test('le verrou d’auteur est rendu quand la capture refuse', async () => {
  const order = [];
  const work = await prepareAdvancedWork({
    // Un projet Libre n'a pas de document d'auteur : il n'y a rien à capturer.
    readProject: () => ({ schemaVersion: 3, projectType: 'pack', rootEntries: [] }),
    readTicket: () => ({ projectEpoch: 1, document: null }),
    holdAuthoring: () => order.push('hold'),
    releaseAuthoring: () => order.push('release'),
    outputFolder: '/sorties',
  });
  assert.equal(work.outcome, ADVANCED_WORK.REFUSED);
  assert.equal(work.refusal.kind, 'request');
  assert.equal(work.refusal.beforeEngine, true);
  // Laisser l'auteur suspendu pour un travail qui n'aura pas lieu serait un
  // verrou sans rien derrière.
  assert.deepEqual(order, ['hold', 'release']);
});

test('sans dossier de sortie, rien n’est capturé et l’auteur est rendu', async () => {
  const order = [];
  const work = await prepareAdvancedWork({
    readProject: () => advancedProject('DOC'),
    readTicket: () => ({ projectEpoch: 1, document: 'DOC' }),
    holdAuthoring: () => order.push('hold'),
    releaseAuthoring: () => order.push('release'),
    outputFolder: '   ',
  });
  assert.equal(work.outcome, ADVANCED_WORK.REFUSED);
  assert.equal(work.refusal.code, 'OUTPUT_FOLDER_REQUIRED');
  assert.deepEqual(order, ['hold', 'release']);
});

// ── Le départ : le poste doit être tenu, et le retour décide ────────────────

const preparedJob = (overrides = {}) => ({
  request: { payload: 'DOC', mediaBindings: [], outputFolder: '/sorties', options: {} },
  revision: exportRevisionToken(advancedProject('DOC')),
  epoch: 1,
  ticketDocument: readAuthoringRevision(advancedProject('DOC')),
  ...overrides,
});

test('le moteur n’est pas appelé si le poste natif n’est pas tenu au nom du graphe', async () => {
  const lock = createNativeGenerationLock();
  lock.acquire({ owner: GENERATION_OWNER_FREE, label: 'génération Libre' });
  let invoked = 0;
  const outcome = await runAdvancedWork({
    job: preparedJob(),
    invokeExport: async () => { invoked += 1; return successResult; },
    lock,
  });
  assert.equal(invoked, 0);
  assert.equal(outcome.outcome, ADVANCED_WORK.REFUSED);
  assert.match(outcome.refusal.message, /poste de travail natif/);
});

test('le poste tenu au nom du graphe laisse passer la demande', async () => {
  const lock = createNativeGenerationLock();
  lock.acquire({ owner: GENERATION_OWNER_ADVANCED, label: 'pack graphe' });
  const sent = [];
  const outcome = await runAdvancedWork({
    job: preparedJob(),
    invokeExport: async (request) => { sent.push(request); return successResult; },
    readTicket: () => ({ projectEpoch: 1, document: readAuthoringRevision(advancedProject('DOC')) }),
    lock,
  });
  assert.equal(sent.length, 1);
  assert.equal(outcome.outcome, ADVANCED_WORK.SUCCEEDED);
  assert.equal(outcome.result.zipPath, '/sorties/pack.zip');
  assert.equal(outcome.ownership, EXPORT_OWNERSHIP.CURRENT);
});

test('un refus typé du moteur garde son type, il ne devient pas un message', async () => {
  const outcome = await runAdvancedWork({
    job: preparedJob(),
    invokeExport: async () => {
      throw { kind: 'media-unavailable', entries: [{ assetRef: 'a1.mp3', cause: 'not-found' }] };
    },
  });
  assert.equal(outcome.outcome, ADVANCED_WORK.REFUSED);
  assert.equal(outcome.refusal.kind, 'media-unavailable');
  assert.equal(outcome.refusal.entries.length, 1);
});

// ── À qui le résultat appartient ────────────────────────────────────────────

test("une archive revenue après un changement de projet n'est pas attribuée au document ouvert", async () => {
  const outcome = await runAdvancedWork({
    job: preparedJob({ epoch: 1 }),
    invokeExport: async () => successResult,
    // L'auteur a ouvert un autre projet pendant l'écriture.
    readTicket: () => ({ projectEpoch: 2, document: readAuthoringRevision(advancedProject('AUTRE')) }),
  });
  assert.equal(outcome.outcome, ADVANCED_WORK.SUCCEEDED);
  // L'archive existe bien, et elle garde la révision qui l'a demandée.
  assert.equal(outcome.result.zipPath, '/sorties/pack.zip');
  assert.equal(outcome.result.epoch, 1);
  assert.equal(outcome.ownership, EXPORT_OWNERSHIP.OTHER_REVISION);
});

test("une mutation de la même époque détache aussi le résultat du document ouvert", async () => {
  // L'époque ne suffit pas : le travail est resté le même, mais le document a
  // changé. Les deux sont donc relus.
  const outcome = await runAdvancedWork({
    job: preparedJob({ epoch: 1 }),
    invokeExport: async () => successResult,
    readTicket: () => ({ projectEpoch: 1, document: readAuthoringRevision(advancedProject('DOC-MODIFIÉ')) }),
  });
  assert.equal(outcome.ownership, EXPORT_OWNERSHIP.OTHER_REVISION);
});

test('un remplacement média détache le résultat, même à payload identique', async () => {
  // `assetRef` appartient au payload, que le remplacement d'un média ne réécrit
  // jamais : deux états que seul un remplacement média sépare portent le même
  // payload, à l'octet.
  const before = advancedProject('DOC', [{ assetRef: 'a1.mp3', path: '/medias/a1.mp3' }]);
  const after = advancedProject('DOC', [{ assetRef: 'a1.mp3', path: '/medias/autre.mp3' }]);
  const outcome = await runAdvancedWork({
    job: preparedJob({ epoch: 1, ticketDocument: readAuthoringRevision(before) }),
    invokeExport: async () => successResult,
    readTicket: () => ({ projectEpoch: 1, document: readAuthoringRevision(after) }),
  });
  assert.equal(outcome.ownership, EXPORT_OWNERSHIP.OTHER_REVISION);
});

// ── Le verrou d'auteur, du côté de la session d'édition ─────────────────────

function authoringSessionOn(applyGesture) {
  let project = advancedProject('DOC-0');
  const session = createAdvancedAuthoringSession({
    readProject: () => project,
    readTicket: () => ({ projectEpoch: 1, document: project.authoring.payload }),
    applyGesture,
    commit: ({ project: next }) => { project = next; },
  });
  return { session, current: () => project };
}

test('pendant le verrou, un geste est refusé à la source : rien ne part', async () => {
  let calls = 0;
  const { session } = authoringSessionOn(async () => {
    calls += 1;
    return { project: advancedProject('DOC-1'), report: {} };
  });
  session.hold('export');
  const outcome = await session.run({ gesture: { gesture: 'set-controls' } });
  assert.equal(outcome.status, GESTURE_HELD);
  assert.equal(calls, 0);

  session.releaseHold();
  const after = await session.run({ gesture: { gesture: 'set-controls' } });
  assert.equal(after.status, GESTURE_APPLIED);
  assert.equal(calls, 1);
});

test('le repos attend le geste déjà en vol, puis se résout', async () => {
  const inFlight = deferred();
  const { session, current } = authoringSessionOn(async () => {
    await inFlight.promise;
    return { project: advancedProject('DOC-1'), report: {} };
  });
  const running = session.run({ gesture: { gesture: 'set-controls' } });
  session.hold('export');

  let settled = false;
  const idle = session.whenIdle().then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  inFlight.resolve();
  await running;
  await idle;
  assert.equal(settled, true);
  // Le document capturé après l'attente est celui que le geste a produit.
  assert.equal(current().authoring.payload, 'DOC-1');
});

test('un repos demandé sur une session déjà au calme est immédiat', async () => {
  const { session } = authoringSessionOn(async () => ({ project: advancedProject('X'), report: {} }));
  await session.whenIdle();
  assert.ok(true);
});

test("un changement de projet pendant une fabrication ne rend pas le document au clavier", async () => {
  const { session } = authoringSessionOn(async () => ({ project: advancedProject('X'), report: {} }));
  session.hold('export');
  session.reset();
  assert.equal(session.state.held, 'export');
  const outcome = await session.run({ gesture: { gesture: 'set-controls' } });
  assert.equal(outcome.status, GESTURE_HELD);
});

test('une seconde prise du verrou d’auteur ne le rend pas deux fois', () => {
  // La file redemande la prise à chaque fois qu'elle porte un travail graphe,
  // et la préparation l'a déjà prise. La seconde demande doit être sans effet,
  // et surtout ne pas laisser une seule libération rendre le document.
  const { session } = authoringSessionOn(async () => ({ project: advancedProject('X'), report: {} }));
  assert.equal(session.hold('export'), true);
  assert.equal(session.hold('export'), false);
  assert.equal(session.state.held, 'export');
  assert.equal(session.releaseHold(), true);
  assert.equal(session.state.held, null);
});
