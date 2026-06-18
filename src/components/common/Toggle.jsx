import { Check, X } from '../icons/LucideLocal';
import './Toggle.css';

export function Toggle({ on, onChange, mixed = false, disabled = false, ariaLabel }) {
  const stateClassName = mixed ? 'mixed' : on ? 'on' : 'off';

  return (
    <button
      type="button"
      className={`tog ${stateClassName}`}
      onClick={() => onChange(!on)}
      aria-pressed={mixed ? 'mixed' : !!on}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <span className="tog-thumb" aria-hidden="true">
        {mixed ? (
          <span className="tog-thumb-mixed" />
        ) : on ? (
          <Check className="tog-thumb-icon" strokeWidth={2.35} absoluteStrokeWidth />
        ) : (
          <X className="tog-thumb-icon" strokeWidth={2.35} absoluteStrokeWidth />
        )}
      </span>
    </button>
  );
}
