import { useTranslation } from 'react-i18next';
import { ChevronRight } from '../../icons/LucideLocal';

export function StoryDisclosure({ open, onToggle, label, children }) {
  const { t } = useTranslation('tree');
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
        <span className="story-disclosure-label">{label === undefined ? t('tree:story.disclosure.label') : label}</span>
      </button>
      {open ? <div className="story-disclosure-body">{children}</div> : null}
    </div>
  );
}
