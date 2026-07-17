import { useCallback } from 'react';
import { getKeyboardResizeDelta, startResize } from './panelResize';

const KEYBOARD_STEP = 16;

// Frontière interactive entre deux panneaux. La largeur lue et annoncée est
// toujours celle du panneau situé à gauche de la poignée.
export function PanelResizeHandle({
  ariaLabel,
  panelClass,
  cssVar,
  direction = 1,
  minWidth,
  maxWidth,
  value,
  defaultValue,
  onResize,
}) {
  const getMaxWidth = useCallback(
    () => (typeof maxWidth === 'function' ? maxWidth() : maxWidth),
    [maxWidth],
  );

  const applyWidth = useCallback((nextWidth) => {
    const max = Math.max(minWidth, getMaxWidth());
    onResize(Math.max(minWidth, Math.min(max, Math.round(nextWidth))));
  }, [getMaxWidth, minWidth, onResize]);

  const handleMouseDown = useCallback((event) => {
    startResize(event, panelClass, cssVar, direction, minWidth, {
      maxWidth: getMaxWidth,
      onResize,
      onStart: () => document.body.classList.add('workspace-is-resizing'),
      onEnd: () => document.body.classList.remove('workspace-is-resizing'),
    });
  }, [cssVar, direction, getMaxWidth, minWidth, onResize, panelClass]);

  const handleKeyDown = useCallback((event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = getKeyboardResizeDelta(event.key, direction, KEYBOARD_STEP);
    applyWidth(value + delta);
  }, [applyWidth, direction, value]);

  const handleDoubleClick = useCallback(() => {
    applyWidth(defaultValue);
  }, [applyWidth, defaultValue]);

  return (
    <div
      className="resize-handle"
      role="separator"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={getMaxWidth()}
      aria-valuenow={value}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
    />
  );
}
