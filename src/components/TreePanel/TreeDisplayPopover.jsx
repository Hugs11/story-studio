import { useEffect, useRef } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { Eye } from '../icons/LucideLocal';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './TreeDisplayPopover.css';

const OPTIONS = [
  {
    key: 'badges',
    label: 'Badges de navigation',
    help: 'Affiche les indications de retour et de parcours sur les lignes.',
  },
  {
    key: 'guides',
    label: 'Rails de guidage',
    help: "Affiche les lignes d'indentation et de branche active dans l'arbre.",
  },
];

export function TreeDisplayPopover({
  open,
  onOpenChange,
  showNavigationBadges,
  onShowNavigationBadgesChange,
  showGuides,
  onShowGuidesChange,
}) {
  const wrapRef = useRef(null);

  useEscapeKey(open, () => onOpenChange?.(false));

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) onOpenChange?.(false);
    }

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onOpenChange]);

  function updateOption(key, value) {
    if (key === 'badges') onShowNavigationBadgesChange?.(value);
    if (key === 'guides') onShowGuidesChange?.(value);
  }

  function getValue(key) {
    return key === 'badges' ? showNavigationBadges : showGuides;
  }

  return (
    <div className={`tree-display-wrap${open ? ' is-open' : ''}`} ref={wrapRef}>
      <Tooltip text="Affichage de l'arbre" placement="below">
        <button
          type="button"
          className={`tree-display-trigger${open ? ' is-active' : ''}`}
          aria-label="Affichage de l'arbre"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => onOpenChange?.(!open)}
        >
          <Eye className="tree-display-trigger-icon" strokeWidth={2.15} absoluteStrokeWidth />
        </button>
      </Tooltip>

      {open ? (
        <div className="tree-display-popover" role="dialog" aria-label="Affichage de l'arbre">
          <div className="tree-display-head">
            <span className="tree-display-title">Affichage</span>
            <span className="tree-display-subtitle">Options visibles dans la structure.</span>
          </div>

          <div className="tree-display-section">
            {OPTIONS.map(({ key, label, help }) => (
              <Tooltip key={key} text={help} wrap className="tree-display-row-tip">
                <div className="tree-display-row">
                  <span className="tree-display-label">{label}</span>
                  <Toggle
                    on={!!getValue(key)}
                    onChange={(value) => updateOption(key, value)}
                    ariaLabel={`${label}. ${help}`}
                  />
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
