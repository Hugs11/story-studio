// Un seul bouton de production.
//
// La preuve centrale est une **absence de changement** : les archives
// produites avant et après sont identiques, octet pour octet, parce que seul le
// chemin d'accès a bougé. Ces tests la tiennent à la frontière, là où elle se
// vérifie sans produire de fichier — ce qui part au moteur, et par quelle
// chaîne.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProductionCommand,
  productionChain,
  PRODUCTION_CHAIN,
} from '../src/store/production/productionRouting.js';
import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
  WORKSPACE_MODE_HOME,
} from '../src/store/projectWorkState.js';
import {
  GENERATION_OWNER_FREE,
  createNativeGenerationLock,
} from '../src/store/nativeGenerationLock.js';
import {
  JOB_STATUS,
  WORK_NATURE,
  newRenderJob,
  nextStartableJob,
} from '../src/store/production/renderQueueWork.js';

function router(workspaceMode) {
  const calls = [];
  let mode = workspaceMode;
  const produce = createProductionCommand({
    readWorkspaceMode: () => mode,
    startFree: (...args) => {
      calls.push({ chain: 'free', args });
      return 'free-started';
    },
    startAdvanced: () => {
      calls.push({ chain: 'advanced', args: [] });
      return 'advanced-started';
    },
  });
  return { produce, calls, setMode: (next) => { mode = next; } };
}

test('la chaîne suit le projet ouvert, et l’accueil n’en a aucune', () => {
  assert.equal(productionChain(WORKSPACE_MODE_HIERARCHICAL), PRODUCTION_CHAIN.FREE);
  assert.equal(productionChain(WORKSPACE_MODE_ADVANCED), PRODUCTION_CHAIN.ADVANCED);
  // Sans projet, il n'y a pas de barre, donc pas de bouton. Rendre une chaîne
  // par défaut y ferait partir une production sans projet.
  assert.equal(productionChain(WORKSPACE_MODE_HOME), null);
  assert.equal(productionChain(undefined), null);
});

test('un seul appel achemine vers la chaîne du projet, et jamais vers l’autre', () => {
  const free = router(WORKSPACE_MODE_HIERARCHICAL);
  assert.equal(free.produce(), 'free-started');
  assert.deepEqual(free.calls.map((call) => call.chain), ['free']);

  const graph = router(WORKSPACE_MODE_ADVANCED);
  assert.equal(graph.produce(), 'advanced-started');
  assert.deepEqual(graph.calls.map((call) => call.chain), ['advanced']);
});

test('à l’accueil, la commande ne lance rien', () => {
  const home = router(WORKSPACE_MODE_HOME);
  assert.equal(home.produce(), undefined);
  assert.deepEqual(home.calls, []);
});

test('le bouton et le raccourci sont la même fonction, donc ne peuvent pas diverger', () => {
  // C'est la forme de la garantie : App n'expose qu'une commande, et la barre
  // comme la table des raccourcis reçoivent **cette** référence. Un test ne
  // peut pas vérifier qu'aucun second chemin n'existe ; il peut vérifier que
  // celui-ci est indifférent à l'appelant.
  const { produce, calls } = router(WORKSPACE_MODE_HIERARCHICAL);
  const fromButton = { preventDefault: () => {} };
  produce(fromButton);
  produce();
  assert.deepEqual(calls.map((call) => call.chain), ['free', 'free']);
  // La chaîne Libre accepte un projet explicite en premier argument et sait
  // déjà distinguer un événement de clic d'un projet : l'acheminement lui passe
  // ce qu'il reçoit, sans l'interpréter.
  assert.equal(calls[0].args[0], fromButton);
  assert.deepEqual(calls[1].args, []);
});

test('changer d’éditeur change de chaîne sans changer de commande', () => {
  const routed = router(WORKSPACE_MODE_HIERARCHICAL);
  routed.produce();
  routed.setMode(WORKSPACE_MODE_ADVANCED);
  routed.produce();
  routed.setMode(WORKSPACE_MODE_HIERARCHICAL);
  routed.produce();
  assert.deepEqual(routed.calls.map((call) => call.chain), ['free', 'advanced', 'free']);
});

// ── Ce que l'acheminement ne fait pas ───────────────────────────────────────

test('l’acheminement ne juge rien : il rend ce que la chaîne rend', async () => {
  // Un routeur qui interpréterait un refus aurait déplacé une porte : il ne
  // fait que router. Ici, un refus traverse sans être touché.
  const refusal = { status: 'refused', kind: 'readiness-blocked' };
  const produce = createProductionCommand({
    readWorkspaceMode: () => WORKSPACE_MODE_ADVANCED,
    startFree: () => assert.fail('la chaîne Libre ne doit pas être appelée'),
    startAdvanced: async () => refusal,
  });
  assert.equal(await produce(), refusal);
});

test('une chaîne qui lève laisse son erreur remonter', async () => {
  const boom = new Error('le moteur a refusé');
  const produce = createProductionCommand({
    readWorkspaceMode: () => WORKSPACE_MODE_HIERARCHICAL,
    startFree: () => { throw boom; },
    startAdvanced: () => assert.fail('la chaîne avancée ne doit pas être appelée'),
  });
  assert.throws(() => produce(), boom);
});

// ── Le poste natif n'est pas contourné par le bouton unique ────────────────
//
// Piège : côté Rust, la génération Libre et l'export avancé partagent le
// **même** canal de progression et le **même** drapeau d'annulation. Menés de
// front, la progression de l'un s'écrirait dans le journal de l'autre, et une
// annulation demandée pour l'un arrêterait les deux. Un bouton unique est
// exactement le genre de changement qui le réintroduirait.
//
// Une production lancée pendant qu'une autre tourne attend dans la file, des
// deux côtés : elle n'échoue pas.

test('une fabrication lancée pendant qu’une autre tourne attend son tour, elle n’échoue pas', () => {
  const lock = createNativeGenerationLock();

  const jobs = [
    newRenderJob({ id: 'libre', createdAt: 1, projectName: 'pack Libre', outputFolder: '/sorties' }),
    newRenderJob({
      id: 'graphe',
      createdAt: 2,
      nature: WORK_NATURE.ADVANCED,
      projectName: 'pack graphe',
      outputFolder: '/sorties',
    }),
  ];

  // Le premier part, quelle que soit sa nature : c'est l'ordre d'arrivée qui
  // sert, et rien d'autre.
  assert.equal(nextStartableJob(jobs).id, 'libre');

  // Pendant qu'il tourne, le second **reste en attente**. Il n'est ni refusé ni
  // marqué en erreur : c'est une règle qui vaut dans les deux sens.
  const running = [{ ...jobs[0], status: JOB_STATUS.RUNNING }, jobs[1]];
  assert.equal(nextStartableJob(running), null);
  assert.equal(running[1].status, JOB_STATUS.PENDING);

  // Le poste natif est tenu par le travail en cours ; sa libération rend la
  // main au suivant.
  const held = lock.acquire({ owner: GENERATION_OWNER_FREE, label: 'pack Libre' });
  assert.ok(held);
  assert.equal(lock.acquire({ owner: 'advanced', label: 'pack graphe' }), null);
  held.release();
  assert.equal(lock.holder, null);

  const settled = [{ ...jobs[0], status: JOB_STATUS.DONE }, jobs[1]];
  assert.equal(nextStartableJob(settled).id, 'graphe');
});

test('l’ordre d’arrivée ne dépend pas de la nature : le graphe ne double pas le Libre', () => {
  const jobs = [
    newRenderJob({
      id: 'graphe', createdAt: 1, nature: WORK_NATURE.ADVANCED,
      projectName: 'pack graphe', outputFolder: '/sorties',
    }),
    newRenderJob({ id: 'libre', createdAt: 2, projectName: 'pack Libre', outputFolder: '/sorties' }),
  ];
  assert.equal(nextStartableJob(jobs).id, 'graphe');
});
