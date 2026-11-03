import { translateProduction } from '../../i18n/productionPresentation.js';
import { presentUserMessage } from '../../i18n/userMessage.js';
// Les trois contrôles de l'éditeur avancé, et ce qu'ils disent d'une production.
//
// L'éditeur avancé possède trois contrôles : une porte de readiness, une porte
// d'identité, et la relecture de l'archive produite. La chaîne Libre les
// applique aussi ; la politique de la production dit lesquels ont le droit de
// refuser.
//
// Ce module ne juge pas : il normalise ce que les deux chaînes rapportent. Il
// continue de distinguer un contrôle qui **décide** d'un contrôle qui
// **observe**, et c'est `blocking` qui porte la différence — un mot dans la
// donnée, pas une nuance dans un libellé. La distinction reste nécessaire même
// quand les deux chaînes bloquent : le moteur reste seul à dire ce qu'il a fait,
// et l'interface n'a pas à le supposer d'après la version qu'elle croit avoir
// en face.
//
// Tout est pur : aucun React, aucun Tauri, aucun disque.

export const GATE_OUTCOME = Object.freeze({
  PASSED: 'passed',
  WOULD_REFUSE: 'would-refuse',
  NOT_OBSERVED: 'not-observed',
});

// Les libellés de verdict, selon que la porte décide ou observe. « Aurait
// refusé » n'a de sens que pour une porte qui n'a rien refusé.
const OUTCOME_LABELS = Object.freeze({
  [GATE_OUTCOME.PASSED]: { blocking: 'production:report.gate.passed', observing: 'production:report.gate.clear' },
  [GATE_OUTCOME.WOULD_REFUSE]: { blocking: 'production:report.gate.refused', observing: 'production:report.gate.wouldRefuse' },
  [GATE_OUTCOME.NOT_OBSERVED]: { blocking: 'production:report.gate.notEvaluated', observing: 'production:report.gate.notObserved' },
});

export const OBSERVATION_NOTICE =
  'production:report.gates.observation';

// Les trois portes de la chaîne avancée, dans l'ordre où elle les exécute.
// Un succès de cette chaîne les a toutes franchies — elle ne peut pas publier
// autrement, ses étapes 2, 3 et 12 précèdent son unique point de publication.
// Les nommer n'invente donc aucun contrôle ; les taire ferait lire « la chaîne
// avancée ne contrôle rien ».
const ADVANCED_GATES = Object.freeze([
  Object.freeze({ gate: 'readiness', label: { code: 'LABEL_EXPORT_READINESS_VALUE', params: {} } }),
  Object.freeze({ gate: 'pack-identity', label: { code: 'LABEL_PACK_IDENTITY_VALUE', params: {} } }),
  Object.freeze({ gate: 'archive-review', label: { code: 'LABEL_ARCHIVE_REVIEW_OPERATION', params: {} } }),
]);

function outcomeLabel(outcome, blocking) {
  const labels = OUTCOME_LABELS[outcome];
  if (!labels) return outcome;
  return translateProduction(blocking ? labels.blocking : labels.observing);
}

function normalizeReason(reason) {
  return Object.freeze({
    code: String(reason?.code ?? ''),
    path: String(reason?.path ?? ''),
    get message() { return presentUserMessage(reason).message; },
  });
}

function normalizeGate(raw) {
  const outcome = Object.values(GATE_OUTCOME).includes(raw?.outcome)
    ? raw.outcome
    : GATE_OUTCOME.NOT_OBSERVED;
  const blocking = raw?.blocking === true;
  const reasons = Array.isArray(raw?.reasons) ? raw.reasons.map(normalizeReason) : [];
  return Object.freeze({
    gate: String(raw?.gate ?? ''),
    get label() { return presentUserMessage(raw?.label ?? '').message; },
    outcome,
    blocking,
    get outcomeLabel() { return outcomeLabel(outcome, blocking); },
    // Un refus sans motif ne se lit pas : la porte le porte toujours, et
    // l'interface n'a pas à deviner lequel.
    reasons: Object.freeze(reasons),
    get note() { return presentUserMessage(raw?.note ?? '').message; },
  });
}

/**
 * Les portes d'une production de la chaîne Libre, telles que le moteur les a
 * observées. Absentes — une production plus ancienne, un travail encore en
 * cours — la liste est vide, et le rapport n'affirme rien.
 */
export function freeProductionGates(observations) {
  if (!Array.isArray(observations)) return Object.freeze([]);
  return Object.freeze(observations.map(normalizeGate));
}

/**
 * Les portes d'un export avancé réussi.
 *
 * Elles sont déduites du succès, pas rapportées par le moteur : la chaîne
 * avancée refuse **avant** de publier, donc une archive publiée a franchi les
 * trois. Sur un refus, rien n'est déduit — le refus typé porte déjà sa raison,
 * et supposer laquelle des trois portes l'a produit serait une invention.
 */
export function advancedProductionGates(succeeded) {
  if (!succeeded) return Object.freeze([]);
  return Object.freeze(
    ADVANCED_GATES.map(({ gate, label }) =>
      normalizeGate({
        gate,
        label,
        outcome: GATE_OUTCOME.PASSED,
        blocking: true,
        note: { code: 'GENERATION_GATE_PUBLICATION_FOLLOWS', params: {} },
      })),
  );
}

/** Vrai dès qu'une porte en observation aurait refusé. */
export function hasObservedRefusal(gates) {
  return gates.some(gate => !gate.blocking && gate.outcome === GATE_OUTCOME.WOULD_REFUSE);
}
