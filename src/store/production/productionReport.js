// Le rapport de production, **un seul**, pour les deux chaînes.
//
// Les deux chaînes ne rendent pas la même chose, et ce module ne prétend pas
// l'inverse. Ce qu'elles ont réellement en commun est court, et c'est
// exactement ce qu'il normalise : où en est la production, ce qui a été
// journalisé, si l'on peut encore l'arrêter, ce qui a été produit, et ce qui a
// échoué. Rien d'autre.
//
// **Il n'invente aucun contrôle.** Les trois contrôles de la chaîne avancée —
// readiness, identité, relecture de l'archive — tournent aussi dans la chaîne
// Libre. Le rapport porte leurs verdicts avec `blocking`, qui dit lequel refuse
// et lequel constate. Afficher les deux sans cette distinction reviendrait à
// annoncer une garantie que la chaîne Libre ne donne pas.
//
// **Il n'aplatit aucun diagnostic.** Un refus de la chaîne avancée est typé et
// porte ses médias manquants, ses collisions, ses désaccords ; une erreur de la
// chaîne Libre est un message. Le rapport porte le **titre et le message**
// communs, et laisse chaque entrée rendre son propre détail à côté. Les réunir
// dans une liste unique aurait forcé à leur faire dire la même chose, ce
// qu'elles ne disent pas.
//
// Les deux listes de problèmes des deux éditeurs, elles, ne se rencontrent pas
// ici : celle du Libre — « éléments à corriger » — est une **porte avant**
// production, qui tient le bouton ; celle de l'avancé est un **diagnostic
// après** départ. Les afficher au même endroit aurait confondu ce qui empêche
// de partir et ce qui explique un retour.
//
// **Il n'y a qu'une fonction.** Un travail graphe, comme un travail Libre,
// vit dans la file de rendu ; les deux rapports lisent donc le même objet, et
// ce qui reste propre à une nature tient en deux branches nommées.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

import { JOB_STATUS, WORK_NATURE } from './renderQueueWork.js';
import {
  advancedProductionGates,
  freeProductionGates,
  hasObservedRefusal,
  OBSERVATION_NOTICE,
} from './productionGates.js';

export const PRODUCTION_SOURCE = Object.freeze({
  FREE: 'free',
  ADVANCED: 'advanced',
});

export const PRODUCTION_STATUS = Object.freeze({
  IDLE: 'idle',
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
});

export const PRODUCTION_STATUS_LABELS = Object.freeze({
  [PRODUCTION_STATUS.IDLE]: 'Aucune production',
  [PRODUCTION_STATUS.PENDING]: 'En attente',
  [PRODUCTION_STATUS.RUNNING]: 'Production en cours',
  [PRODUCTION_STATUS.SUCCEEDED]: 'Pack produit',
  [PRODUCTION_STATUS.CANCELLED]: 'Production annulée',
  [PRODUCTION_STATUS.FAILED]: 'Production interrompue',
});

// Une attente utile, dite avec les mots de l'auteur. Une fois le travail fini,
// il n'y a plus rien à annoncer : le résultat ou le problème est déjà visible.
const PROGRESS_IN_PROGRESS = "Le pack apparaîtra ici dès qu'il sera prêt.";

// Une production antérieure au branchement des portes, ou un travail qui n'est
// pas allé jusqu'à l'archive, n'a rien à en dire. Le dire est le seul moyen de
// ne pas présenter comme exécuté un contrôle qui ne l'a pas été.
export const GATES_NOT_REPORTED =
  "Contrôles d'archive : cette production n'en rapporte aucun.";

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function report({
  source,
  status,
  lines = [],
  cancelAvailable = false,
  cancelRequested = false,
  result = null,
  problem = null,
  gates = [],
}) {
  const shown = asList(lines).map(String);
  return Object.freeze({
    source,
    status,
    statusLabel: PRODUCTION_STATUS_LABELS[status],
    // « Préparation » n'est pas un état de production : la capture
    // du document a lieu avant que le travail entre dans la file, et n'a donc
    // pas de ligne à décrire.
    busy: status === PRODUCTION_STATUS.RUNNING,
    progress: Object.freeze({
      lines: Object.freeze(shown),
      // Le compte est celui des lignes, parce que la file les garde toutes.
      // Le journal vit dans le travail, pour les deux chaînes, et rien n'est
      // coupé.
      count: shown.length,
      note: status === PRODUCTION_STATUS.PENDING || status === PRODUCTION_STATUS.RUNNING
        ? PROGRESS_IN_PROGRESS
        : null,
    }),
    cancel: Object.freeze({ available: cancelAvailable, requested: cancelRequested }),
    result: result ? Object.freeze(result) : null,
    problem: problem ? Object.freeze(problem) : null,
    // Les trois contrôles d'archive, avec ce qu'ils ont dit et ce qu'ils
    // valent. Une production peut n'en rapporter aucun ; c'est alors `note` qui
    // parle, plutôt qu'une liste vide qu'on lirait « tout va bien ».
    gates: Object.freeze({
      entries: Object.freeze(gates),
      observing: gates.some(gate => !gate.blocking),
      observedRefusal: hasObservedRefusal(gates),
      notice: gates.some(gate => !gate.blocking) ? OBSERVATION_NOTICE : null,
      note: gates.length === 0 ? GATES_NOT_REPORTED : null,
    }),
  });
}

// Les cinq états d'un travail de la file, dits dans les mots de la production.
// Les deux natures les partagent : un travail graphe est un travail
// de la file, et il n'a pas d'état que le Libre n'aurait pas.
const JOB_TO_PRODUCTION = Object.freeze({
  [JOB_STATUS.PENDING]: PRODUCTION_STATUS.PENDING,
  [JOB_STATUS.RUNNING]: PRODUCTION_STATUS.RUNNING,
  [JOB_STATUS.DONE]: PRODUCTION_STATUS.SUCCEEDED,
  [JOB_STATUS.CANCELED]: PRODUCTION_STATUS.CANCELLED,
  [JOB_STATUS.ERROR]: PRODUCTION_STATUS.FAILED,
});

/**
 * Le rapport d'un travail de la file de rendu — **les deux natures**.
 *
 * Un seul lieu, donc une seule fonction. La nature ne change que deux choses,
 * et chacune pour une raison :
 *
 * - **la provenance des contrôles d'archive.** La chaîne Libre rapporte ce que
 *   les trois portes ont observé, travail par travail ; la chaîne graphe
 *   les exerce pour de bon, et ne rapporte donc pas des observations mais un
 *   verdict lié à la publication de l'archive.
 * - **la forme du problème.** Un refus de la chaîne graphe est typé et porte ses
 *   médias manquants, ses collisions, ses désaccords ; une erreur de la chaîne
 *   Libre est un message. Le rapport porte le **titre et le message** communs,
 *   et laisse chaque entrée rendre son propre détail à côté.
 *
 * Les avertissements audio accompagnent un **succès** : le ZIP est utilisable,
 * et les ranger dans les problèmes en ferait un échec.
 */
export function renderJobReport(job) {
  if (!job) return null;
  const advanced = job.nature === WORK_NATURE.ADVANCED;
  const status = JOB_TO_PRODUCTION[job.status] ?? PRODUCTION_STATUS.IDLE;
  const succeeded = status === PRODUCTION_STATUS.SUCCEEDED;
  const refusal = job.refusal ?? null;
  return report({
    source: advanced ? PRODUCTION_SOURCE.ADVANCED : PRODUCTION_SOURCE.FREE,
    status,
    lines: job.logs,
    cancelAvailable: status === PRODUCTION_STATUS.PENDING || status === PRODUCTION_STATUS.RUNNING,
    cancelRequested: job.cancelRequested === true,
    result: succeeded
      ? {
        zipPath: job.resultPath ?? null,
        outputFolder: job.outputFolder ?? null,
        // Les deux chaînes rendent désormais leurs avertissements au même
        // endroit, dans le rapport commun.
        warnings: advanced ? asList(job.result?.warnings) : asList(job.warnings),
      }
      : null,
    // Une annulation se dit par son état, des deux côtés : ce n'est pas un
    // problème à exposer.
    problem: status === PRODUCTION_STATUS.CANCELLED ? null : advanced
      ? (refusal && !succeeded ? { title: refusal.title, message: refusal.message } : null)
      : (status === PRODUCTION_STATUS.FAILED && job.errorMessage
        ? { title: PRODUCTION_STATUS_LABELS[PRODUCTION_STATUS.FAILED], message: String(job.errorMessage) }
        : null),
    gates: advanced
      ? advancedProductionGates(succeeded && !!job.resultPath)
      // La chaîne Libre rapporte ce que les trois contrôles ont
      // observé. Elle ne leur obéit pas : le pack est publié qu'ils signalent un
      // motif de refus ou non.
      : freeProductionGates(job.gateObservations),
  });
}
