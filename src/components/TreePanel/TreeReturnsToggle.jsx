import { Tooltip } from '../common/Tooltip';
import { Undo2 } from '../icons/LucideLocal';
import './TreePanel.css';

export function TreeReturnsToggle({ enabled, onChange }) {
  return (
    <Tooltip text={`${enabled ? 'Masquer' : 'Afficher'} les retours dans l'arbre`} placement="below">
      <button
        type="button"
        className={`tree-returns-toggle${enabled ? ' is-active' : ''}`}
        aria-label={`${enabled ? 'Masquer' : 'Afficher'} les retours dans l'arbre`}
        aria-pressed={enabled}
        onClick={() => onChange(!enabled)}
      >
        <Undo2 className="tree-returns-toggle-icon" strokeWidth={2.2} absoluteStrokeWidth />
      </button>
    </Tooltip>
  );
}
