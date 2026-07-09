import { useCallback, useMemo, useState } from 'react';
import {
  clampStepIndex,
  nextStepIndex,
  prevStepIndex,
  isLastStep as isLastStepAt,
  stepCounterLabel,
} from './funnelNavigation.js';

/**
 * Machine à états partagée des funnels.
 *
 * Le hook ne connaît que la *navigation* (phase + index d'étape) ; chaque
 * funnel garde ses propres données métier et calcule lui-même la validité de
 * l'étape courante (`canContinue`). On évite ainsi de coupler le châssis à un
 * schéma de données particulier.
 *
 * Familles de sortie :
 *  - `editor`     : la collecte terminée ouvre l'éditeur (pas de phase `processing`).
 *  - `generative` : collecte → génération → terminé → retour accueil.
 *  - `tool`       : fichier → analyse/correction → terminé → retour accueil.
 *
 * @param {Object}   options
 * @param {number}   options.stepCount        Nombre d'étapes de saisie.
 * @param {'editor'|'generative'|'tool'} [options.family='editor']
 * @param {number}   [options.initialStep=0]
 * @param {Function} [options.onStepChange]   Notifié à chaque changement d'étape.
 */
export function useFunnel({ stepCount, family = 'editor', initialStep = 0, onStepChange } = {}) {
  const [phase, setPhase] = useState('collect');
  const [stepIndex, setStepIndexState] = useState(() => clampStepIndex(initialStep, stepCount));

  const applyStep = useCallback((resolver) => {
    setStepIndexState((current) => {
      const target = clampStepIndex(
        typeof resolver === 'function' ? resolver(current) : resolver,
        stepCount,
      );
      if (target !== current) onStepChange?.(target, current);
      return target;
    });
  }, [stepCount, onStepChange]);

  const goToStep = useCallback((index) => applyStep(index), [applyStep]);
  const goNext = useCallback(() => applyStep((i) => nextStepIndex(i, stepCount)), [applyStep, stepCount]);
  const goBack = useCallback(() => applyStep((i) => prevStepIndex(i, stepCount)), [applyStep, stepCount]);

  // Familles `generative`/`tool` : bascule vers l'écran de traitement.
  const startProcessing = useCallback(() => setPhase('processing'), []);
  // Fin du traitement → écran « Terminé ».
  const complete = useCallback(() => setPhase('done'), []);

  const reset = useCallback(() => {
    setPhase('collect');
    setStepIndexState(clampStepIndex(initialStep, stepCount));
  }, [initialStep, stepCount]);

  const lastStep = isLastStepAt(stepIndex, stepCount);

  return useMemo(() => ({
    family,
    phase,                       // 'collect' | 'processing' | 'done'
    stepIndex,
    stepCount,
    isLastStep: lastStep,
    isFirstStep: stepIndex === 0,
    stepLabel: stepCounterLabel(stepIndex, stepCount),
    // Le châssis (stepper + pied) n'est visible que pendant la collecte.
    showChrome: phase === 'collect',
    goToStep,
    goNext,
    goBack,
    startProcessing,
    complete,
    reset,
  }), [
    family, phase, stepIndex, stepCount, lastStep,
    goToStep, goNext, goBack, startProcessing, complete, reset,
  ]);
}
