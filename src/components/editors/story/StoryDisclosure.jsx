import { ChevronRight } from '../../icons/LucideLocal';

export function StoryDisclosure({ open, onToggle, label = 'Réglages avancés', children }) {
  return (
    <div className={`story-disclosure ${open ? 'is-open' : ''}`}>
      <button
        type="button"
        className="story-disclosure-trigger"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="story-disclosure-chevron" aria-hidden="true">
          <ChevronRight strokeWidth={2} absoluteStrokeWidth />
        </span>
        <span className="story-disclosure-label">{label}</span>
      </button>
      {open ? <div className="story-disclosure-body">{children}</div> : null}
    </div>
  );
}
