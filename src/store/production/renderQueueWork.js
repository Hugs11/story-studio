// Une file, deux natures de travail.
//
// La file de rendu sert deux genres de travail : un document Libre sérialisé,
// confié à `generate_pack`, et un document graphe, confié à
// `export_advanced_pack`. L'auteur suit ainsi l'avancement de son pack au même
// endroit, quelle que soit la chaîne qui le fabrique.
//
// Ce module ne fusionne aucun moteur : les deux commandes Rust partagent le
// poste de travail natif, le canal de progression et le drapeau d'annulation.
// Il décrit **un travail**, quelle que soit sa nature, et les trois décisions
// que l'exécuteur prend sur cette description : lequel démarrer, lequel
// arrêter, et ce que son retour veut dire.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque. C'est la condition
// pour éprouver l'ordonnancement et l'annulation sans machine.

import {
  GENERATION_OWNER_ADVANCED,
  GENERATION_OWNER_FREE,
} from '../nativeGenerationLock.js';

export const WORK_NATURE = Object.freeze({
  FREE: 'free',
  ADVANCED: 'advanced',
});

export const JOB_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELED: 'canceled',
});

const TERMINAL = new Set([JOB_STATUS.DONE, JOB_STATUS.ERROR, JOB_STATUS.CANCELED]);

export function isTerminalStatus(status) {
  return TERMINAL.has(status);
}

export function isActiveStatus(status) {
  return status === JOB_STATUS.PENDING || status === JOB_STATUS.RUNNING;
}

// Qui tient le poste natif pour cette nature. Le verrou ne sert pas à
// ordonnancer la file — l'exécuteur ne lance qu'un travail à la fois de toute
// façon — mais à dire **qui** l'occupe : le poste est unique par application, et
// l'étiquette du propriétaire est ce qu'on lit quand quelque chose coince.
export function nativeOwnerOf(nature) {
  return nature === WORK_NATURE.ADVANCED ? GENERATION_OWNER_ADVANCED : GENERATION_OWNER_FREE;
}

/**
 * Le travail, tel que la file le porte.
 *
 * `id` et `createdAt` sont **injectés** plutôt que fabriqués ici : un travail se
 * décrit sans horloge ni générateur aléatoire, et c'est ce qui permet de
 * comparer deux descriptions dans un test.
 *
 * Les deux natures ne portent pas la même chose, et c'est assumé :
 *
 * - un travail **Libre** transporte son document sérialisé (`projectJson`), une
 *   chaîne produite par `JSON.stringify` au moment de la demande ;
 * - un travail **graphe** transporte la demande déjà bâtie (`request`). Ce n'est
 *   pas une seconde copie du document : le payload d'auteur est une chaîne
 *   opaque et immuable, et la demande en tient la **même** référence. Le décrire
 *   ainsi fige la révision au clic, ce qui est la promesse faite à l'auteur —
 *   le pack fabriqué est celui qu'il regardait quand il a demandé.
 */
export function newRenderJob({
  id,
  createdAt,
  nature = WORK_NATURE.FREE,
  projectName,
  savePath = null,
  outputFolder,
  projectJson = null,
  request = null,
  revision = null,
  epoch = null,
  ticketDocument = null,
  readinessSummary = null,
} = {}) {
  return {
    id,
    createdAt,
    nature,
    projectName: projectName || '(sans nom)',
    savePath,
    outputFolder,
    status: JOB_STATUS.PENDING,
    cancelRequested: false,
    logs: [],
    resultPath: null,
    warnings: [],
    // Ce que les trois contrôles d'archive ont observé. Vide tant que
    // le moteur n'a pas rendu la main : le rapport dit alors qu'il n'en
    // rapporte aucun, plutôt que de laisser lire un franchissement.
    gateObservations: [],
    errorMessage: null,
    // ── Nature Libre ────────────────────────────────────────────────────────
    projectJson,
    // ── Nature graphe ───────────────────────────────────────────────────────
    request,
    // Le témoin de ce qui est parti — payload **et** liaisons —, et l'époque du
    // projet au moment de la demande. Relus au retour, ils disent si l'archive
    // appartient encore au document ouvert.
    revision,
    epoch,
    ticketDocument,
    // La qualification de **cette** révision, retenue avec le travail. Les
    // limites affichées sous une archive décrivent ce qui a été produit, pas ce
    // que le document est devenu depuis.
    readinessSummary,
    result: null,
    refusal: null,
    ownership: 'current',
  };
}

/**
 * Le prochain travail à démarrer, ou `null`.
 *
 * Un seul travail tourne à la fois, quelle que soit sa nature : le poste natif
 * est unique, et deux travaux menés de front mêleraient leur progression sur le
 * même canal et partageraient la même annulation. Les natures ne se doublent
 * donc pas — c'est l'ordre d'arrivée qui sert, et rien d'autre.
 */
export function nextStartableJob(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (list.some((job) => job.status === JOB_STATUS.RUNNING)) return null;
  return list.find((job) => job.status === JOB_STATUS.PENDING) ?? null;
}

/**
 * Le travail dont l'annulation doit encore être transmise au moteur, ou `null`.
 *
 * Seul un travail **en cours** a quelque chose à arrêter : un travail en attente
 * annulé n'a jamais rien lancé, et la file le passe directement à « annulé »
 * sans rien demander à personne. C'est ce qui remplace, sans le recopier, le
 * cas « annulation demandée pendant la préparation » que la session d'export
 * tenait à part.
 */
export function jobAwaitingCancelSignal(jobs, alreadySentFor = null) {
  const list = Array.isArray(jobs) ? jobs : [];
  const job = list.find((entry) => entry.status === JOB_STATUS.RUNNING && entry.cancelRequested === true);
  if (!job || job.id === alreadySentFor) return null;
  return job;
}

/**
 * Reste-t-il un travail graphe demandé et pas encore terminé ?
 *
 * C'est la condition de la **suspension de l'édition**. Elle est dérivée de la
 * file, jamais tenue à côté : un verrou d'auteur qui vivrait dans un composant
 * survivrait à un travail abandonné, ou disparaîtrait au démontage pendant que
 * l'archive s'écrit. L'auteur est suspendu **dès le clic**, attente comprise,
 * et pas seulement pendant l'écriture.
 */
export function hasActiveAdvancedWork(jobs) {
  return (Array.isArray(jobs) ? jobs : [])
    .some((job) => job.nature === WORK_NATURE.ADVANCED && isActiveStatus(job.status));
}

/**
 * Ce que le retour de `generate_pack` vaut.
 *
 * Le chemin du ZIP est la seule preuve de succès de cette chaîne : son absence
 * est une panne, pas un succès muet.
 */
export function freeJobOutcome(generationResult) {
  const resultPath = typeof generationResult === 'string'
    ? generationResult
    : generationResult?.zipPath ?? null;
  if (!resultPath) throw new Error('Le moteur n’a renvoyé aucun chemin de ZIP.');
  return {
    resultPath,
    warnings: Array.isArray(generationResult?.warnings) ? generationResult.warnings : [],
    // Ce que les trois contrôles d'archive ont observé. Ils ne décident
    // de rien ici : le travail est réussi ou non par son seul chemin de ZIP.
    gateObservations: Array.isArray(generationResult?.gateObservations)
      ? generationResult.gateObservations
      : [],
  };
}

// Une panne dont le message dit l'annulation en est une : le moteur rend son
// abandon par le message, et la file ne le range pas dans les erreurs.
export function readsAsCancellation(message) {
  return String(message ?? '').toLowerCase().includes('annul');
}
