/**
 * Helpers purs du châssis de funnel (plan 03).
 *
 * Aucune dépendance React : la logique de navigation pas-à-pas et de
 * dérivation d'état du stepper est isolée ici pour être testée seule
 * (`scripts/funnelNavigation.test.mjs`). `useFunnel` consomme ces helpers.
 */

/** Familles de sortie d'un funnel (cf. plan 03 §3). */
export const FUNNEL_FAMILIES = Object.freeze(['editor', 'generative', 'tool']);

/** Phases d'un funnel : saisie → traitement → terminé. */
export const FUNNEL_PHASES = Object.freeze(['collect', 'processing', 'done']);

/** Borne un index d'étape dans `[0, count - 1]` (0 si la liste est vide). */
export function clampStepIndex(index, count) {
  const max = Math.max(0, count - 1);
  if (!Number.isFinite(index)) return 0;
  return Math.min(max, Math.max(0, Math.trunc(index)));
}

/** Étape suivante, plafonnée à la dernière. */
export function nextStepIndex(index, count) {
  return clampStepIndex(index + 1, count);
}

/** Étape précédente, plancher à la première. */
export function prevStepIndex(index, count) {
  return clampStepIndex(index - 1, count);
}

/** Vrai si `index` est la dernière étape de saisie. */
export function isLastStep(index, count) {
  return count > 0 && clampStepIndex(index, count) === count - 1;
}

/**
 * Statut visuel d'une pastille du stepper.
 * `errorSteps` (Set ou tableau d'index) force l'état `error` tant que l'étape
 * n'est pas dépassée — utile pour signaler une validation manquante.
 */
export function deriveStepStatus(stepIndex, currentIndex, errorSteps = null) {
  const hasError = errorSteps
    ? (errorSteps instanceof Set ? errorSteps.has(stepIndex) : errorSteps.includes(stepIndex))
    : false;
  if (stepIndex === currentIndex) return hasError ? 'error' : 'current';
  if (stepIndex < currentIndex) return hasError ? 'error' : 'done';
  return 'todo';
}

/** Libellé centré du pied : « Étape N / M » (1-indexé). */
export function stepCounterLabel(index, count) {
  if (count <= 0) return '';
  return `Étape ${clampStepIndex(index, count) + 1} / ${count}`;
}

/**
 * Le bouton « Suivant/Continuer » est-il actif ?
 * `validity` peut être un booléen, `null`/`undefined` (= toujours actif), ou
 * une chaîne (message d'erreur friendly → bloquant). On centralise la règle
 * pour que tous les funnels se comportent pareil.
 */
export function canContinue(validity) {
  if (validity === null || validity === undefined) return true;
  if (typeof validity === 'string') return validity.trim() === '';
  return Boolean(validity);
}
