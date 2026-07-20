export const LEFT_PANEL_MIN_WIDTH = 200;
export const TREE_PANEL_MAX_WIDTH = 900;

export function getKeyboardResizeDelta(key, direction, step = 16) {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return 0;
  const visualDelta = key === 'ArrowRight' ? step : -step;
  return visualDelta * direction;
}

export function getPointerResizeDelta(currentX, startX, direction) {
  return direction === 1 ? currentX - startX : startX - currentX;
}

export function startResize(e, panelClass, cssVar, direction, minWidth = 150, options = {}) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = document.querySelector(panelClass)?.clientWidth ?? minWidth;
  const getMaxWidth = typeof options.maxWidth === 'function'
    ? options.maxWidth
    : () => options.maxWidth ?? window.innerWidth * 0.42;
  let currentWidth = startW;

  options.onStart?.();

  const applyWidth = (width) => {
    const maxWidth = Math.max(minWidth, getMaxWidth());
    currentWidth = Math.max(minWidth, Math.min(maxWidth, width));
    if (cssVar) document.documentElement.style.setProperty(cssVar, `${currentWidth}px`);
    options.onResize?.(currentWidth);
  };

  const onMove = ev => {
    const delta = getPointerResizeDelta(ev.clientX, startX, direction);
    applyWidth(startW + delta);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    options.onEnd?.(currentWidth);
    options.onCommit?.(currentWidth);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
