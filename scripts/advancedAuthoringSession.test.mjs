// La session d'édition de l'Éditeur avancé.
//
// Tout est **pur** : aucun moteur d'affichage, aucun React, aucun Tauri. Ces tests
// prouvent : un seul geste en vol, une file qui ne capture pas de payload, une
// réponse périmée jetée sans erreur, et un refus qui laisse le projet intact.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdvancedAuthoringSession,
  GESTURE_APPLIED,
  GESTURE_BUSY,
  GESTURE_QUEUED,
  GESTURE_REFUSED,
  GESTURE_STALE,
  documentUntouchedBy,
} from '../src/store/advancedAuthoring/authoringSession.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((settle, fail) => { resolve = settle; reject = fail; });
  return { promise, resolve, reject };
}

// Un banc minimal : un « projet » est un objet portant un document, et un geste
// produit le document suivant. Le store réel range davantage ; la session, elle,
// ne connaît que ces trois fonctions.
function harness({ applyGesture } = {}) {
  const state = {
    epoch: 0,
    project: { document: 'v0' },
    commits: [],
    changes: [],
  };
  const session = createAdvancedAuthoringSession({
    readProject: () => state.project,
    readTicket: () => ({ projectEpoch: state.epoch, document: state.project.document }),
    applyGesture: applyGesture ?? (async (project, gesture) => ({
      project: { document: `${project.document}+${gesture.gesture}` },
      report: { gesture: gesture.gesture },
    })),
    commit: ({ project, report, intent }) => {
      state.project = project;
      state.commits.push({ project, report, intent });
    },
    onChange: (snapshot) => state.changes.push(snapshot),
  });
  return { state, session };
}

test('un geste marqué hors historique le dit au commit', async () => {
  // C'est ce que lit `useAdvancedAuthoring` pour ne pas ouvrir d'étape
  // d'undo : le rangement posé seul à l'ouverture d'un pack sans disposition.
  const { state, session } = harness();
  await session.run({ gesture: { gesture: 'apply-view-layout' }, history: false });
  await session.run({ gesture: { gesture: 'set-square-one' } });
  assert.equal(state.commits[0].intent.history, false);
  assert.equal(state.commits[1].intent.history, undefined);
});

test('un geste accepté installe le projet rendu et porte son rapport', async () => {
  const { state, session } = harness();
  const outcome = await session.run({ gesture: { gesture: 'set-square-one' } });
  assert.equal(outcome.status, GESTURE_APPLIED);
  assert.equal(state.project.document, 'v0+set-square-one');
  assert.equal(state.commits.length, 1);
  assert.deepEqual(session.state.lastReport.report, { gesture: 'set-square-one' });
  assert.ok(!session.state.busy);
});

// Le rapport retient le projet que son geste a produit : un Ctrl+Z passe par
// l'historique du store, pas par la session, et c'est cette comparaison qui
// permet à l'interface de taire un rapport que le document ne reflète plus.
test('le rapport retient le projet que son geste a produit', async () => {
  const { state, session } = harness();
  await session.run({ gesture: { gesture: 'set-square-one' } });
  assert.equal(session.state.lastReport.project, state.project);
});

test('un refus laisse le projet précédent littéralement intact', async () => {
  const refusal = { code: 'STAGE_STILL_TARGETED', path: '/stageNodes/@uuid=a#0', references: ['r1'] };
  const { state, session } = harness({
    applyGesture: async () => { throw refusal; },
  });
  const before = state.project;
  const outcome = await session.run({ gesture: { gesture: 'delete-stage' } });
  assert.equal(outcome.status, GESTURE_REFUSED);
  assert.equal(outcome.error, refusal);
  // Aucune installation : l'objet courant est le même, pas une copie égale.
  assert.equal(state.project, before);
  assert.equal(state.commits.length, 0);
  assert.equal(session.state.refusal.error, refusal);
  session.clearRefusal();
  assert.equal(session.state.refusal, null);
});

test('un second geste discret est empêché à la source tant que le premier est en vol', async () => {
  const gate = deferred();
  const { state, session } = harness({
    applyGesture: async (project) => {
      await gate.promise;
      return { project: { document: `${project.document}+lent` }, report: {} };
    },
  });
  const first = session.run({ gesture: { gesture: 'lent' } });
  assert.ok(session.state.busy);
  const second = await session.run({ gesture: { gesture: 'refusé-à-la-source' } });
  assert.deepEqual(second, { status: GESTURE_BUSY });
  gate.resolve();
  assert.equal((await first).status, GESTURE_APPLIED);
  // Le geste empêché n'a produit aucune écriture : il n'a jamais été envoyé.
  assert.equal(state.commits.length, 1);
});

test('une intention continue est mise en file et relit le projet au moment de l\'envoi', async () => {
  const gate = deferred();
  const sentFrom = [];
  const { state, session } = harness({
    applyGesture: async (project, gesture) => {
      sentFrom.push(project.document);
      if (gesture.gesture === 'premier') await gate.promise;
      return { project: { document: `${project.document}+${gesture.gesture}` }, report: {} };
    },
  });
  const first = session.coalesce({ kind: 'position', build: () => ({ gesture: 'premier' }) });
  const queued = await session.coalesce({ kind: 'position', build: () => ({ gesture: 'second' }) });
  assert.deepEqual(queued, { status: GESTURE_QUEUED });
  // Une troisième demande **remplace** la seconde : l'auteur veut la dernière
  // position, pas la trace de toutes celles qu'il a traversées.
  await session.coalesce({ kind: 'position', build: () => ({ gesture: 'troisième' }) });
  gate.resolve();
  await first;
  await new Promise((settle) => { setTimeout(settle, 0); });

  assert.equal(state.project.document, 'v0+premier+troisième');
  // La file n'a **jamais** capturé de payload : le second envoi est parti du
  // document que le premier venait de produire.
  assert.deepEqual(sentFrom, ['v0', 'v0+premier']);
});

test('une réponse périmée par un changement de projet est jetée sans erreur', async () => {
  const gate = deferred();
  const { state, session } = harness({
    applyGesture: async (project) => {
      await gate.promise;
      return { project: { document: `${project.document}+tardif` }, report: {} };
    },
  });
  const pending = session.run({ gesture: { gesture: 'tardif' } });
  // Le travail courant est remplacé pendant le vol.
  state.epoch += 1;
  state.project = { document: 'autre-projet' };
  gate.resolve();
  const outcome = await pending;
  assert.deepEqual(outcome, { status: GESTURE_STALE });
  assert.equal(state.commits.length, 0);
  assert.equal(state.project.document, 'autre-projet');
});

test('une réponse périmée par un undo est jetée sans erreur ni refus', async () => {
  const gate = deferred();
  const { state, session } = harness({
    applyGesture: async (project) => {
      await gate.promise;
      return { project: { document: `${project.document}+tardif` }, report: {} };
    },
  });
  const pending = session.run({ gesture: { gesture: 'tardif' } });
  // Même projet, valeur antérieure : le ticket de document a bougé.
  state.project = { document: 'v-1' };
  gate.resolve();
  assert.deepEqual(await pending, { status: GESTURE_STALE });
  assert.equal(state.commits.length, 0);
  assert.equal(session.state.refusal, null);
});

test('un relevé de disque pendant le vol ne périme pas le geste', async () => {
  const gate = deferred();
  const { state, session } = harness({
    applyGesture: async (project) => {
      await gate.promise;
      return { project: { document: `${project.document}+ok` }, report: {} };
    },
  });
  const pending = session.run({ gesture: { gesture: 'ok' } });
  // L'audit des liaisons remplace l'objet projet sans toucher au document :
  // il est neutre pour la machine de fraîcheur.
  state.project = { ...state.project, mediaBindings: [{ status: 'missing' }] };
  gate.resolve();
  assert.equal((await pending).status, GESTURE_APPLIED);
  assert.equal(state.commits.length, 1);
});

test('un refus périmé n\'est pas affiché comme un refus', async () => {
  const gate = deferred();
  const { state, session } = harness({
    applyGesture: async () => {
      await gate.promise;
      throw { code: 'UNKNOWN_STAGE', path: '/x' };
    },
  });
  const pending = session.run({ gesture: { gesture: 'perdu' } });
  state.epoch += 1;
  gate.resolve();
  assert.deepEqual(await pending, { status: GESTURE_STALE });
  assert.equal(session.state.refusal, null);
});

test('la remise à zéro vide la file sans toucher au projet', async () => {
  const gate = deferred();
  const { state, session } = harness({
    applyGesture: async (project) => {
      await gate.promise;
      return { project: { document: `${project.document}+a` }, report: {} };
    },
  });
  const pending = session.run({ gesture: { gesture: 'a' } });
  await session.coalesce({ kind: 'position', build: () => ({ gesture: 'b' }) });
  assert.ok(session.state.queuedIntent !== null);
  session.reset();
  assert.equal(session.state.queuedIntent, null);
  assert.equal(session.state.lastReport, null);
  gate.resolve();
  await pending;
  assert.equal(state.project.document, 'v0+a');
});

// ── Raccord au travail réel : l'historique du store ──────────────────────────
//
// Les transitions ci-dessous sont celles de `projectWorkState.js`, pilotées hors
// React par `workStateDriver`. Le double est React, jamais la décision testée :
// c'est ce qui permet de prouver « un geste validé = une étape d'undo » sans
// monter une interface.

const { createAdvancedProject, readAuthoringPayload, readAuthoringRevision } = await import('../src/store/projectModel.js');
const { createWorkSnapshot, hasUnsavedWork } = await import('../src/store/projectHelpers.js');
const { workState } = await import('./workStateDriver.mjs');

const BASE_PAYLOAD = '{"payloadVersion":1,"document":{"title":"T","version":1,"format":"v1",'
  + '"stageNodes":[{"uuid":"u-1","squareOne":true}],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';

function storeHarness(applyGesture) {
  const work = workState(createAdvancedProject({ payload: BASE_PAYLOAD, projectName: 'essai' }));
  const session = createAdvancedAuthoringSession({
    readProject: () => work.project,
    // Le ticket de production : la révision d'auteur complète, payload **et**
    // chemins de liaisons. C'est exactement ce que `useAdvancedAuthoring`
    // fournit à la session.
    readTicket: () => ({
      projectEpoch: work.epoch,
      document: readAuthoringRevision(work.project),
    }),
    applyGesture,
    commit: ({ project }) => work.mutate(() => project),
  });
  return { work, session };
}

test('un geste validé correspond à une étape undo, et une seule', async () => {
  const { work, session } = storeHarness(async (project) => ({
    project: {
      ...project,
      authoring: { ...project.authoring, payload: `${readAuthoringPayload(project)} ` },
    },
    report: {},
  }));
  const before = readAuthoringPayload(work.project);

  await session.run({ gesture: { gesture: 'set-square-one' } });
  assert.equal(work.history.length, 1);
  assert.equal(work.redo.length, 0);

  assert.ok(work.undo());
  // L'annulation restaure le payload **à l'octet** : l'historique porte la
  // valeur entière, il ne rejoue aucun geste inverse.
  assert.equal(readAuthoringPayload(work.project), before);
  assert.ok(work.redo());
  assert.equal(readAuthoringPayload(work.project), `${before} `);
});

test('un geste refusé ne crée aucune étape undo et ne salit pas le travail', async () => {
  const { work, session } = storeHarness(async () => {
    throw { code: 'SQUARE_ONE_REMOVAL', path: '/stageNodes/@uuid=u-1#0' };
  });
  const snapshot = createWorkSnapshot(work.project, [], {});
  const outcome = await session.run({ gesture: { gesture: 'delete-stage' } });

  assert.equal(outcome.status, GESTURE_REFUSED);
  assert.equal(work.history.length, 0);
  assert.equal(work.redo.length, 0);
  // La signature de travail est inchangée : rien n'a été écrit au-dessus.
  assert.equal(createWorkSnapshot(work.project, [], {}), snapshot);
  assert.equal(
    hasUnsavedWork({ project: work.project, mediaLibraryPaths: [], mediaTags: {}, savedSnapshot: snapshot }),
    false,
  );
});

test('un geste parti d\'un état annulé entre-temps n\'écrase pas l\'état courant', async () => {
  const gate = deferred();
  const { work, session } = storeHarness(async (project) => {
    await gate.promise;
    return {
      project: {
        ...project,
        authoring: { ...project.authoring, payload: `${readAuthoringPayload(project)} tardif` },
      },
      report: {},
    };
  });
  // Un premier geste crée une étape, puis l'auteur l'annule pendant le vol du
  // second.
  const pending = session.run({ gesture: { gesture: 'lent' } });
  work.mutate((project) => ({
    ...project,
    authoring: { ...project.authoring, payload: `${readAuthoringPayload(project)} local` },
  }));
  gate.resolve();

  assert.deepEqual(await pending, { status: GESTURE_STALE });
  assert.ok(readAuthoringPayload(work.project).endsWith(' local'));
  assert.equal(work.history.length, 1);
});


// ── La fraîcheur d'une liaison média ─────────────────────────────────────────
//
// Remplacer le fichier derrière une référence change le **chemin d'une
// liaison** ; `assetRef` appartient au payload, que le remplacement d'un média
// ne réécrit jamais. Deux états que seul un remplacement sépare portent donc le
// même payload, à l'octet.
//
// Tant que le ticket ne comptait que le payload, une réponse revenue après
// l'annulation du remplacement était jugée fraîche : elle réinstallait le projet
// qu'elle avait capturé, et le fichier écarté revenait sans nouvelle intention
// de l'auteur.

const ASSET_REF = 'a1b2c3.wav';

function boundProject(path, payload = BASE_PAYLOAD) {
  return createAdvancedProject({
    payload,
    projectName: 'essai',
    mediaBindings: [{ assetRef: ASSET_REF, path, status: 'resolved' }],
  });
}

const bindingPath = (project) => project.authoring.mediaBindings[0].path;

// Re-pointer la liaison : c'est « Tous les usages… » et c'est aussi ce que la
// consolidation fait quand elle copie les médias à côté du projet.
function relink(project, path) {
  return {
    ...project,
    authoring: {
      ...project.authoring,
      mediaBindings: project.authoring.mediaBindings.map((binding) => ({ ...binding, path })),
    },
  };
}

function bindingHarness({ path = 'C:/ancien.wav' } = {}) {
  const gate = deferred();
  const work = workState(boundProject(path));
  const session = createAdvancedAuthoringSession({
    readProject: () => work.project,
    readTicket: () => ({
      projectEpoch: work.epoch,
      document: readAuthoringRevision(work.project),
    }),
    // Le geste rend le projet **capturé**, payload muté : c'est littéralement ce
    // qu'un retour tardif réinstallerait, liaisons comprises.
    applyGesture: async (project) => {
      await gate.promise;
      return {
        project: {
          ...project,
          authoring: { ...project.authoring, payload: `${readAuthoringPayload(project)} ` },
        },
        report: {},
      };
    },
    commit: ({ project }) => work.mutate(() => project),
  });
  return { work, session, gate };
}

test("une réponse tardive ne rétablit pas un remplacement média que l'auteur a annulé", async () => {
  const { work, session, gate } = bindingHarness();
  // L'auteur remplace le fichier derrière la référence : une étape d'undo.
  work.mutate((project) => relink(project, 'C:/nouveau.wav'));
  assert.equal(bindingPath(work.project), 'C:/nouveau.wav');

  // Une autre édition part, puis le remplacement est annulé pendant son vol.
  const pending = session.run({ gesture: { gesture: 'set-controls' } });
  assert.ok(work.undo());
  assert.equal(bindingPath(work.project), 'C:/ancien.wav');
  // Le payload, lui, est identique à l'octet : c'est ce qui faisait passer la
  // réponse pour fraîche.
  assert.equal(readAuthoringPayload(work.project), BASE_PAYLOAD);

  gate.resolve();
  assert.deepEqual(await pending, { status: GESTURE_STALE });
  assert.equal(bindingPath(work.project), 'C:/ancien.wav',
    "le choix annulé ne revient pas sans nouvelle intention de l'auteur");
  assert.equal(readAuthoringPayload(work.project), BASE_PAYLOAD, "rien n'a été installé au-dessus");
  assert.equal(session.state.refusal, null, "une réponse périmée n'est pas un refus");
});

test('undo puis redo rend la réponse de nouveau fraîche : la fraîcheur est une valeur', async () => {
  const { work, session, gate } = bindingHarness();
  work.mutate((project) => relink(project, 'C:/nouveau.wav'));

  const pending = session.run({ gesture: { gesture: 'set-controls' } });
  work.undo();
  work.redo();
  assert.equal(bindingPath(work.project), 'C:/nouveau.wav');

  gate.resolve();
  assert.equal((await pending).status, GESTURE_APPLIED,
    'revenu au même état, le geste est installé : aucun compteur ne le périme');
  assert.equal(bindingPath(work.project), 'C:/nouveau.wav');
});

test("une consolidation ou un Save As qui re-pointe les liaisons périme la réponse en vol", async () => {
  const { work, session, gate } = bindingHarness();
  const pending = session.run({ gesture: { gesture: 'set-controls' } });
  // La consolidation copie les médias à côté du projet et réinstalle les
  // liaisons re-pointées : installer le projet capturé ramènerait les anciens
  // chemins absolus.
  work.mutate((project) => relink(project, 'D:/Projet/assets/audio/intro.wav'));

  gate.resolve();
  assert.deepEqual(await pending, { status: GESTURE_STALE });
  assert.equal(bindingPath(work.project), 'D:/Projet/assets/audio/intro.wav');
});

test("un audit de statut n'est pas une édition : la réponse reste installée", async () => {
  const { work, session, gate } = bindingHarness();
  const pending = session.run({ gesture: { gesture: 'set-controls' } });
  // `status` est le dernier état connu du disque, redérivé à chaque audit. Le
  // compter ferait jeter un geste parfaitement valide.
  work.mutate((project) => ({
    ...project,
    authoring: {
      ...project.authoring,
      mediaBindings: project.authoring.mediaBindings.map((binding) => ({ ...binding, status: 'missing' })),
    },
  }));

  gate.resolve();
  assert.equal((await pending).status, GESTURE_APPLIED);
  assert.ok(readAuthoringPayload(work.project).endsWith(' '));
});

test("un changement de projet pendant le vol jette la réponse, liaisons comprises", async () => {
  const { work, session, gate } = bindingHarness();
  const pending = session.run({ gesture: { gesture: 'set-controls' } });
  // Même payload, même chemin de liaison : seule l'époque sépare les deux
  // travaux, et elle suffit.
  work.install(boundProject('C:/ancien.wav'));

  gate.resolve();
  assert.deepEqual(await pending, { status: GESTURE_STALE });
  assert.equal(readAuthoringPayload(work.project), BASE_PAYLOAD);
  assert.equal(work.history.length, 0);
});

test("un glisser lâché pendant un export laisse le document tel quel et se dit comme un refus", async () => {
  // Le canvas a déjà peint la carte à sa nouvelle place : seul ce retour lui
  // dit de la remettre sur la position du document.
  const { state, session } = harness();
  session.hold('export');
  const outcome = await session.coalesce({ kind: 'position:a', build: () => ({ gesture: 'set-authored-position' }) });
  assert.equal(state.project.document, 'v0');
  assert.equal(state.commits.length, 0);
  assert.equal(documentUntouchedBy(outcome), true);
  assert.equal(documentUntouchedBy({ status: GESTURE_REFUSED }), true);
  assert.equal(documentUntouchedBy({ status: GESTURE_APPLIED }), false);
  assert.equal(documentUntouchedBy({ status: GESTURE_QUEUED }), false);
});
