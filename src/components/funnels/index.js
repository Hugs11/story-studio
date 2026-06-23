/**
 * Châssis commun des funnels (plan 03) — point d'entrée public.
 *
 * Les funnels de la 0.9.3 (modifier un pack, podcast, agréger, YouTube,
 * vérifier/corriger…) composent ces primitives plutôt que de réimplémenter
 * overlay, stepper, navigation et écrans de sortie.
 */
export { FunnelShell } from './FunnelShell.jsx';
export { FunnelStepper } from './FunnelStepper.jsx';
export { FunnelFooter } from './FunnelFooter.jsx';
export { FunnelSectionHeader } from './FunnelSectionHeader.jsx';
export { FunnelToolButton } from './FunnelToolButton.jsx';
export { FunnelGenerationState } from './FunnelGenerationState.jsx';
export { FunnelDoneState } from './FunnelDoneState.jsx';
export { useFunnel } from './useFunnel.js';
export {
  FUNNEL_FAMILIES,
  FUNNEL_PHASES,
  clampStepIndex,
  nextStepIndex,
  prevStepIndex,
  isLastStep,
  deriveStepStatus,
  stepCounterLabel,
  canContinue,
} from './funnelNavigation.js';
