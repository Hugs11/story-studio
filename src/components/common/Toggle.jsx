import './Toggle.css';

export function Toggle({ on, onChange, mixed = false, disabled = false, ariaLabel }) {
  return (
    <button
      type="button"
      className={`tog ${mixed ? 'mixed' : on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
      aria-pressed={mixed ? 'mixed' : !!on}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <span className="tog-thumb" />
    </button>
  );
}
