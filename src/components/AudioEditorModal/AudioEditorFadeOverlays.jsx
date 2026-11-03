import { Button } from '../common/Button';
import { formatTime } from './audioEditorConstants';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

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
  const { t } = useMediaTranslation();
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
              ? t('media:audioEditor.fade.edit')
              : fadeContextMenu.target === 'in'
                ? t('media:audioEditor.fade.addIn')
                : fadeContextMenu.target === 'out'
                  ? t('media:audioEditor.fade.addOut')
                  : t('media:audioEditor.fade.add')}
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
            <div className="audio-editor-fade-popover-title">{t(config.labelKey)}</div>
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
              <Button size="sm" onClick={() => onSetFadeValue(fadePopover.target, 0)}>{t('media:delete.remove.action')}</Button>
              <Button size="sm" variant="primary" onClick={onPopoverOk}>{t('common:dialog.confirm.label')}</Button>
            </div>
          </div>
        );
      })()}
    </>
  );
}
