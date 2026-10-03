// Une file, deux natures de travail.
//
// Il faut établir, plutôt que croire sur la foi d'un commentaire, que
// « l'annulation de la file atteint réellement un export graphe en cours ». Cette
// suite l'établit du côté JavaScript : elle monte la file et son exécuteur avec
// des doubles de commandes Tauri, et lit **ce qui est réellement envoyé au
// moteur**.
//
// Ce qu'elle ne peut pas dire, et qui est éprouvé ailleurs : que le moteur
// obéisse au drapeau et ne laisse rien derrière lui. Cela appartient aux tests
// Rust de `native_pack/advanced_export/tests/refusals.rs`, qui vérifient qu'un
// export annulé ne publie aucune archive et ne laisse aucun `.partial`. Les deux
// moitiés se rejoignent sur un seul fait, lui aussi vérifiable :
// `cancel_generate_pack` bascule le `GenerationCancelState` que `generate_pack`
// **et** `export_advanced_pack` relisent.
//
// Le banc de hooks remplace `useState`/`useEffect` par des variables et un rendu
// déclenché explicitement ; aucune règle n'est recopiée, les hooks de production
// sont importés intacts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { runner } from './reactHookDriver.mjs';

register('./nodeSourceResolver.mjs', import.meta.url);

const { useRenderQueueStore } = await import('../src/store/renderQueueStore.js');
const { useRenderQueueExecutor } = await import('../src/hooks/useRenderQueueExecutor.js');
const {
  JOB_STATUS,
  WORK_NATURE,
  freeJobOutcome,
  hasActiveAdvancedWork,
  jobAwaitingCancelSignal,
  nativeOwnerOf,
  newRenderJob,
  nextStartableJob,
} = await import('../src/store/production/renderQueueWork.js');
const {
  GENERATION_OWNER_ADVANCED,
  GENERATION_OWNER_FREE,
  createNativeGenerationLock,
} = await import('../src/store/nativeGenerationLock.js');

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const FREE_RESULT = { zipPath: '/sorties/libre.zip', warnings: [], gateObservations: [] };
const GRAPH_RESULT = {
  zipPath: '/sorties/graphe.zip',
  conversions: [],
  destinations: [],
  warnings: [],
  packIdentity: 'PACK-1',
  hasThumbnail: true,
};

// Le banc : la file, son exécuteur, et des doubles pour tout ce qui touche au
// monde réel. Le rendu est déclenché à la main, et `settle` le rejoue jusqu'à
// ce que plus rien ne bouge — c'est l'équivalent de laisser React converger.
function bench({ invoke, lock = createNativeGenerationLock(), ticket = () => ({ projectEpoch: 1, document: 'DOC' }) } = {}) {
  let emitProgress = () => {};
  let queue = null;
  const calls = [];

  const harness = runner(() => {
    queue = useRenderQueueStore();
    useRenderQueueExecutor({
      jobs: queue.jobs,
      updateJob: queue.updateJob,
      appendLog: queue.appendLog,
      lock,
      readAdvancedTicket: ticket,
      isRuntime: () => true,
      invoke: (command, args) => {
        calls.push({ command, args });
        return invoke(command, args);
      },
      subscribeProgress: (onLine) => { emitProgress = onLine; return () => { emitProgress = () => {}; }; },
      notify: () => {},
    });
  });

  async function settle(rounds = 8) {
    for (let index = 0; index < rounds; index += 1) {
      harness.render();
      harness.flush();
      await Promise.resolve();
      await Promise.resolve();
    }
  }

  // Premier rendu : la file existe avant qu'on lui demande quoi que ce soit.
  harness.render();
  harness.flush();

  return {
    lock,
    calls,
    settle,
    emit: (line) => emitProgress(line),
    get queue() { return queue; },
    commandsNamed: (name) => calls.filter((call) => call.command === name),
    jobNamed: (name) => queue.jobs.find((job) => job.projectName === name),
  };
}

const graphJob = (name = 'pack graphe') => ({
  nature: WORK_NATURE.ADVANCED,
  projectName: name,
  outputFolder: '/sorties',
  request: { payload: 'DOC', mediaBindings: [], outputFolder: '/sorties', options: {} },
  revision: 'REV-1',
  epoch: 1,
  ticketDocument: 'DOC',
  readinessSummary: { blocked: false, blocking: [] },
});

const freeJob = (name = 'pack libre') => ({
  projectName: name,
  outputFolder: '/sorties',
  projectJson: '{"projectName":"pack libre"}',
});

// ── L'ordonnancement, sans machine ──────────────────────────────────────────

test('un seul travail tourne à la fois, quelle que soit sa nature', () => {
  const jobs = [
    newRenderJob({ id: 'a', createdAt: 1, projectName: 'A', outputFolder: '/s' }),
    newRenderJob({ id: 'b', createdAt: 2, nature: WORK_NATURE.ADVANCED, projectName: 'B', outputFolder: '/s' }),
  ];
  assert.equal(nextStartableJob(jobs).id, 'a');
  assert.equal(nextStartableJob([{ ...jobs[0], status: JOB_STATUS.RUNNING }, jobs[1]]), null);
  assert.equal(nextStartableJob([]), null);
});

test('le poste natif porte le nom de la nature qui l’occupe', () => {
  assert.equal(nativeOwnerOf(WORK_NATURE.FREE), GENERATION_OWNER_FREE);
  assert.equal(nativeOwnerOf(WORK_NATURE.ADVANCED), GENERATION_OWNER_ADVANCED);
});

test('seul un travail en cours a quelque chose à arrêter', () => {
  const pending = newRenderJob({ id: 'a', createdAt: 1, projectName: 'A', outputFolder: '/s' });
  // Un travail en attente annulé n'a jamais rien lancé : rien n'est demandé au
  // moteur. C'est ce qui remplace, sans le recopier, le cas « annulation
  // pendant la préparation » que la session d'export tenait à part.
  assert.equal(jobAwaitingCancelSignal([{ ...pending, cancelRequested: true }]), null);
  const running = { ...pending, status: JOB_STATUS.RUNNING, cancelRequested: true };
  assert.equal(jobAwaitingCancelSignal([running]).id, 'a');
  // Le geste n'est pas renvoyé deux fois pour le même travail.
  assert.equal(jobAwaitingCancelSignal([running], 'a'), null);
});

test('la suspension de l’édition est dérivée de la file, pas tenue à côté', () => {
  const graph = newRenderJob({ id: 'g', createdAt: 1, nature: WORK_NATURE.ADVANCED, projectName: 'G', outputFolder: '/s' });
  const free = newRenderJob({ id: 'f', createdAt: 1, projectName: 'F', outputFolder: '/s' });
  assert.equal(hasActiveAdvancedWork([graph]), true);
  assert.equal(hasActiveAdvancedWork([{ ...graph, status: JOB_STATUS.RUNNING }]), true);
  // Terminé, annulé ou en erreur : il n'y a plus rien à attendre.
  for (const status of [JOB_STATUS.DONE, JOB_STATUS.CANCELED, JOB_STATUS.ERROR]) {
    assert.equal(hasActiveAdvancedWork([{ ...graph, status }]), false);
  }
  // Un travail Libre ne suspend rien : cette chaîne n'a pas de verrou d'auteur.
  assert.equal(hasActiveAdvancedWork([free]), false);
});

test('le chemin du ZIP est la seule preuve de succès de la chaîne Libre', () => {
  assert.deepEqual(freeJobOutcome('/sorties/pack.zip').resultPath, '/sorties/pack.zip');
  assert.deepEqual(freeJobOutcome({ zipPath: '/x.zip', warnings: [1], gateObservations: [2] }), {
    resultPath: '/x.zip', warnings: [1], gateObservations: [2],
  });
  assert.throws(() => freeJobOutcome({ warnings: [] }), /aucun chemin de ZIP/);
});

// ── La file sert les deux natures ───────────────────────────────────────────

test('un travail graphe part sur sa commande, et le compteur de la barre le compte', async () => {
  const bed = bench({ invoke: async (command) => (command === 'export_advanced_pack' ? GRAPH_RESULT : null) });
  bed.queue.addJob(graphJob());
  await bed.settle();

  const [sent] = bed.commandsNamed('export_advanced_pack');
  assert.ok(sent, 'la commande du graphe est celle qui part');
  assert.equal(sent.args.payload, 'DOC');
  assert.equal(bed.commandsNamed('generate_pack').length, 0);

  const job = bed.jobNamed('pack graphe');
  assert.equal(job.status, JOB_STATUS.DONE);
  assert.equal(job.resultPath, '/sorties/graphe.zip');
  assert.equal(job.ownership, 'current');
  // Le poste natif est rendu, et rien ne reste en cours.
  assert.equal(bed.lock.holder, null);
  assert.equal(bed.queue.activeCount, 0);
  assert.equal(bed.queue.hasResults, true);
});

test('le compteur compte un travail graphe comme un travail Libre', async () => {
  const blocked = deferred();
  const bed = bench({ invoke: async () => blocked.promise });
  bed.queue.addJob(graphJob());
  await bed.settle();
  assert.equal(bed.queue.activeCount, 1);
  assert.equal(bed.queue.advancedWorkActive, true);
  blocked.resolve(GRAPH_RESULT);
  await bed.settle();
  assert.equal(bed.queue.activeCount, 0);
  assert.equal(bed.queue.advancedWorkActive, false);
});

test('la progression du moteur est routée vers le travail graphe en cours', async () => {
  const blocked = deferred();
  const bed = bench({ invoke: async () => blocked.promise });
  bed.queue.addJob(graphJob());
  await bed.settle();

  bed.emit('  transfert 12/40');
  await bed.settle(2);
  const job = bed.jobNamed('pack graphe');
  assert.ok(job.logs.includes('  transfert 12/40'));
  // Aucune ligne ne conclut : le travail est toujours en cours.
  assert.equal(job.status, JOB_STATUS.RUNNING);

  blocked.resolve(GRAPH_RESULT);
  await bed.settle();
});

// ── L'annulation : une preuve, pas une déduction ─────────────────────────────

test('annuler un travail graphe en cours envoie réellement le geste au moteur', async () => {
  const running = deferred();
  const bed = bench({
    invoke: async (command) => {
      if (command === 'export_advanced_pack') return running.promise;
      return null;
    },
  });
  bed.queue.addJob(graphJob());
  await bed.settle();
  assert.equal(bed.jobNamed('pack graphe').status, JOB_STATUS.RUNNING);

  bed.queue.cancelJob(bed.jobNamed('pack graphe').id);
  await bed.settle();

  // Le geste partagé, celui-là même que la chaîne Libre envoie. Côté Rust,
  // `cancel_generate_pack` bascule le drapeau que les deux commandes relisent.
  assert.equal(bed.commandsNamed('cancel_generate_pack').length, 1);
  assert.equal(bed.jobNamed('pack graphe').cancelRequested, true);

  // Le moteur répond par son refus typé d'abandon.
  running.reject({ kind: 'export-cancelled', message: 'Export annulé.' });
  await bed.settle();

  const job = bed.jobNamed('pack graphe');
  // Une annulation n'est pas une panne, et rien n'est présenté comme produit.
  assert.equal(job.status, JOB_STATUS.CANCELED);
  assert.equal(job.resultPath, null);
  assert.equal(job.refusal.kind, 'export-cancelled');
  assert.equal(job.errorMessage, null);
  assert.equal(bed.lock.holder, null);
});

test('une panne d’écriture pendant un abandon reste une panne, pas une annulation', async () => {
  // C'est la branche du nettoyage `.partial` : la ranger dans les annulations
  // masquerait un résidu sur le disque.
  const running = deferred();
  const bed = bench({ invoke: async (command) => (command === 'export_advanced_pack' ? running.promise : null) });
  bed.queue.addJob(graphJob());
  await bed.settle();
  bed.queue.cancelJob(bed.jobNamed('pack graphe').id);
  await bed.settle();
  running.reject({ kind: 'output-write', message: 'disque plein', path: '/sorties/graphe.zip.partial' });
  await bed.settle();

  const job = bed.jobNamed('pack graphe');
  assert.equal(job.status, JOB_STATUS.ERROR);
  assert.equal(job.refusal.kind, 'output-write');
  assert.equal(job.refusal.residue, true);
});

test('un travail graphe annulé pendant qu’il attend ne démarre jamais', async () => {
  const running = deferred();
  const bed = bench({ invoke: async (command) => (command === 'generate_pack' ? running.promise : null) });
  bed.queue.addJob(freeJob());
  await bed.settle();
  bed.queue.addJob(graphJob());
  await bed.settle();

  const waiting = bed.jobNamed('pack graphe');
  assert.equal(waiting.status, JOB_STATUS.PENDING);

  bed.queue.cancelJob(waiting.id);
  await bed.settle();
  assert.equal(bed.jobNamed('pack graphe').status, JOB_STATUS.CANCELED);

  running.resolve(FREE_RESULT);
  await bed.settle();

  // Rien n'a été demandé au moteur pour ce travail-là : ni départ, ni
  // annulation. C'est ce qui remplace la garde « annulé pendant la préparation ».
  assert.equal(bed.commandsNamed('export_advanced_pack').length, 0);
  assert.equal(bed.commandsNamed('cancel_generate_pack').length, 0);
});

// ── Les deux natures s'enchaînent ───────────────────────────────────────────

test('deux fabrications lancées coup sur coup se servent dans l’ordre', async () => {
  const first = deferred();
  const bed = bench({
    invoke: async (command) => {
      if (command === 'generate_pack') return first.promise;
      if (command === 'export_advanced_pack') return GRAPH_RESULT;
      return null;
    },
  });

  bed.queue.addJob(freeJob());
  await bed.settle();
  bed.queue.addJob(graphJob());
  await bed.settle();

  // Le second **attend**, il n'échoue pas : c'est une règle qui vaut dans les deux
  // sens.
  assert.equal(bed.jobNamed('pack libre').status, JOB_STATUS.RUNNING);
  assert.equal(bed.jobNamed('pack graphe').status, JOB_STATUS.PENDING);
  assert.equal(bed.commandsNamed('export_advanced_pack').length, 0);
  assert.equal(bed.lock.holder.owner, GENERATION_OWNER_FREE);

  first.resolve(FREE_RESULT);
  await bed.settle();

  assert.equal(bed.jobNamed('pack libre').status, JOB_STATUS.DONE);
  assert.equal(bed.jobNamed('pack graphe').status, JOB_STATUS.DONE);
  assert.equal(bed.commandsNamed('export_advanced_pack').length, 1);
  assert.equal(bed.lock.holder, null);
});

test('un travail Libre attend son tour derrière une fabrication graphe', async () => {
  const first = deferred();
  const bed = bench({
    invoke: async (command) => {
      if (command === 'export_advanced_pack') return first.promise;
      if (command === 'generate_pack') return FREE_RESULT;
      return null;
    },
  });

  bed.queue.addJob(graphJob());
  await bed.settle();
  bed.queue.addJob(freeJob());
  await bed.settle();

  assert.equal(bed.jobNamed('pack libre').status, JOB_STATUS.PENDING);
  assert.equal(bed.lock.holder.owner, GENERATION_OWNER_ADVANCED);
  assert.equal(bed.commandsNamed('generate_pack').length, 0);

  first.resolve(GRAPH_RESULT);
  await bed.settle();
  assert.equal(bed.jobNamed('pack libre').status, JOB_STATUS.DONE);
});

// ── Ce que la file garde ────────────────────────────────────────────────────

test('le résultat d’une fabrication graphe survit à ce qui l’a lancée', async () => {
  const bed = bench({ invoke: async () => GRAPH_RESULT });
  bed.queue.addJob(graphJob());
  await bed.settle();

  const job = bed.jobNamed('pack graphe');
  // Le compte rendu détaillé voyage **avec** le travail : il n'est ni résumé
  // ni remplacé, et il ne dépend plus d'un tiroir qui peut se fermer.
  assert.equal(job.result.zipPath, '/sorties/graphe.zip');
  assert.equal(job.result.hasThumbnail, true);
  assert.equal(job.readinessSummary.blocked, false);
  assert.equal(job.revision, 'REV-1');

  // Fermer le panneau ne touche à rien ; seul un retrait explicite efface la
  // ligne, et le fichier reste sur le disque.
  bed.queue.setPanelOpen(false);
  await bed.settle(1);
  assert.equal(bed.jobNamed('pack graphe').result.zipPath, '/sorties/graphe.zip');
});

test('une archive revenue pour une autre révision garde son fichier et le dit', async () => {
  const bed = bench({
    invoke: async () => GRAPH_RESULT,
    // L'auteur a changé de projet pendant l'écriture.
    ticket: () => ({ projectEpoch: 2, document: 'AUTRE' }),
  });
  bed.queue.addJob(graphJob());
  await bed.settle();

  const job = bed.jobNamed('pack graphe');
  assert.equal(job.status, JOB_STATUS.DONE);
  assert.equal(job.resultPath, '/sorties/graphe.zip');
  assert.equal(job.ownership, 'other-revision');
});

test('la chaîne Libre n’a pas changé : mêmes arguments, même verdict', async () => {
  const bed = bench({ invoke: async () => FREE_RESULT });
  bed.queue.addJob(freeJob());
  await bed.settle();

  const [sent] = bed.commandsNamed('generate_pack');
  assert.deepEqual(sent.args, {
    projectJson: '{"projectName":"pack libre"}',
    outputFolder: '/sorties',
  });
  const job = bed.jobNamed('pack libre');
  assert.equal(job.nature, WORK_NATURE.FREE);
  assert.equal(job.status, JOB_STATUS.DONE);
  assert.equal(job.resultPath, '/sorties/libre.zip');
  assert.equal(bed.commandsNamed('export_advanced_pack').length, 0);
});

// ── Annulation tardive : les deux natures disent la même chose ─────────────
//
// L'auteur annule alors que le ZIP vient d'être publié, ou pendant un abandon
// dont le nettoyage échoue. Le fichier publié garde son chemin ; la panne de
// nettoyage reste une panne. Les deux natures partagent la file et le geste.

async function cancelThenAnswer({ command, job, answer }) {
  const running = deferred();
  const bed = bench({ invoke: async (name) => (name === command ? running.promise : null) });
  bed.queue.addJob(job);
  await bed.settle();
  bed.queue.cancelJob(bed.jobNamed(job.projectName).id);
  await bed.settle();
  assert.equal(bed.commandsNamed('cancel_generate_pack').length, 1);
  answer(running);
  await bed.settle();
  return { bed, job: bed.jobNamed(job.projectName) };
}

for (const nature of [
  { label: 'graphe', command: 'export_advanced_pack', job: graphJob, result: GRAPH_RESULT },
  { label: 'Libre', command: 'generate_pack', job: freeJob, result: FREE_RESULT },
]) {
  test(`${nature.label} : un ZIP publié avant l’annulation est présenté comme fait, avec son chemin`, async () => {
    const { bed, job } = await cancelThenAnswer({
      command: nature.command,
      job: nature.job(),
      answer: (running) => running.resolve(nature.result),
    });
    assert.equal(job.status, JOB_STATUS.DONE);
    assert.equal(job.resultPath, nature.result.zipPath);
    assert.equal(job.cancelRequested, false);
    assert.equal(bed.lock.holder, null);
  });
}

test('graphe : une panne de nettoyage pendant l’abandon reste visible', async () => {
  const { job } = await cancelThenAnswer({
    command: 'export_advanced_pack',
    job: graphJob(),
    answer: (running) => running.reject({
      kind: 'output-write',
      message: 'Le fichier incomplet n’a pas pu être supprimé',
      path: '/sorties/graphe.zip.partial',
    }),
  });
  assert.equal(job.status, JOB_STATUS.ERROR);
  assert.equal(job.refusal.kind, 'output-write');
  assert.ok(job.errorMessage);
});

test('Libre : une panne de nettoyage pendant l’abandon reste visible', async () => {
  const cleanupFailure = "Le fichier incomplet '/sorties/libre.zip.partial' n'a pas pu être supprimé après l'arrêt du transfert: accès refusé";
  const { job } = await cancelThenAnswer({
    command: 'generate_pack',
    job: freeJob(),
    answer: (running) => running.reject(cleanupFailure),
  });
  assert.equal(job.status, JOB_STATUS.ERROR);
  assert.equal(job.errorMessage, cleanupFailure);
  assert.equal(job.resultPath ?? null, null);
  assert.equal(job.cancelRequested, false);
});

test('Libre (témoin) : l’abandon rapporté par le moteur reste une annulation', async () => {
  const { job } = await cancelThenAnswer({
    command: 'generate_pack',
    job: freeJob(),
    answer: (running) => running.reject('Génération annulée.'),
  });
  assert.equal(job.status, JOB_STATUS.CANCELED);
  assert.equal(job.resultPath, null);
  assert.equal(job.errorMessage, null);
});
