export const LEFT_PANEL_MIN_WIDTH = 300;

export function startResize(e, panelClass, cssVar, direction, minWidth = 150, options = {}) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = document.querySelector(panelClass)?.clientWidth ?? minWidth;
  const getMaxWidth = typeof options.maxWidth === 'function'
    ? options.maxWidth
    : () => options.maxWidth ?? window.innerWidth * 0.42;
  let currentWidth = startW;

  const applyWidth = (width) => {
    const maxWidth = Math.max(minWidth, getMaxWidth());
    currentWidth = Math.max(minWidth, Math.min(maxWidth, width));
    if (cssVar) document.documentElement.style.setProperty(cssVar, `${currentWidth}px`);
    options.onResize?.(currentWidth);
  };

  const onMove = ev => {
    const delta = direction === 1 ? ev.clientX - startX : startX - ev.clientX;
    applyWidth(startW + delta);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    options.onCommit?.(currentWidth);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
