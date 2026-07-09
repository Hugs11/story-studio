import { Check } from '../icons/LucideLocal';
import { deriveStepStatus } from './funnelNavigation.js';

/**
 * Stepper horizontal cliquable du châssis.
 *
 * Navigation libre : cliquer une pastille saute à l'étape (`onStepClick`).
 * Le statut de chaque étape est dérivé de `current` ; `errorSteps` force l'état
 * `error` (validation manquante) sur les étapes concernées.
 *
 * @param {Object}   props
 * @param {{key?: string, label: string}[]} props.steps
 * @param {number}   props.current               Index de l'étape courante.
 * @param {Function} props.onStepClick           (index) => void
 * @param {Set<number>|number[]} [props.errorSteps]
 * @param {boolean}  [props.disabled=false]      Désactive la navigation directe.
 */
export function FunnelStepper({ steps, current, onStepClick, errorSteps = null, disabled = false }) {
  return (
    <div className="funnel-stepper">
      <div className="funnel-stepper-track">
        {steps.map((step, index) => {
          const status = deriveStepStatus(index, current, errorSteps);
          const isDone = status === 'done';
          return (
            <button
              type="button"
              key={step.key ?? index}
              className={`funnel-step is-${status}`}
              onClick={() => onStepClick?.(index)}
              disabled={disabled}
              aria-current={status === 'current' ? 'step' : undefined}
            >
              <span className="funnel-step-connector" aria-hidden="true" />
              <span className="funnel-step-circle">
                {isDone ? <Check strokeWidth={3} /> : index + 1}
              </span>
              <span className="funnel-step-label">{step.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
