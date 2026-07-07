import { Button } from '../common/Button';
import { formatTime } from './audioEditorConstants';

// Menu contextuel + popover de réglage d'un fondu, positionnés au pointeur.
export function AudioEditorFadeOverlays({
  fadeContextMenu,
  fadePopover,
  currentFadeValue,
  fadeConfig,
  onOpenContextFadePopover,
  onSetFadeValue,
  onPopoverOk,
}) {
  return (
    <>
      {fadeContextMenu && (
        <div
          className="audio-editor-fade-context-menu"
          style={{ left: fadeContextMenu.x, top: fadeContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button className="audio-editor-fade-context-item" onClick={onOpenContextFadePopover}>
            {currentFadeValue(fadeContextMenu.target) > 0
              ? 'Modifier le fondu'
              : fadeContextMenu.target === 'in'
                ? 'Ajouter un fondu en entrée'
                : fadeContextMenu.target === 'out'
                  ? 'Ajouter un fondu en sortie'
                  : 'Ajouter un fondu'}
          </button>
        </div>
      )}

      {fadePopover && (() => {
        const config = fadeConfig(fadePopover.target);
        return (
          <div
            className="audio-editor-fade-popover"
            style={{ left: fadePopover.x, top: fadePopover.y }}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <div className="audio-editor-fade-popover-title">{config.label}</div>
            <div className="audio-editor-row">
              <input
                type="range"
                min={0}
                max={config.max}
                step={0.05}
                value={config.value}
                onChange={(e) => onSetFadeValue(fadePopover.target, e.target.value)}
                autoFocus
              />
              <span className="audio-editor-zoom-val">{formatTime(config.value)}</span>
            </div>
            <div className="audio-editor-fade-popover-actions">
              <Button size="sm" onClick={() => onSetFadeValue(fadePopover.target, 0)}>Retirer</Button>
              <Button size="sm" variant="primary" onClick={onPopoverOk}>OK</Button>
            </div>
          </div>
        );
      })()}
    </>
  );
}
