export const LEFT_PANEL_MIN_WIDTH = 300;

export function startResize(e, panelClass, cssVar, direction, minWidth = 150) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = document.querySelector(panelClass)?.clientWidth ?? minWidth;
  const onMove = ev => {
    const delta = direction === 1 ? ev.clientX - startX : startX - ev.clientX;
    const newW = Math.max(minWidth, Math.min(window.innerWidth * 0.42, startW + delta));
    document.documentElement.style.setProperty(cssVar, `${newW}px`);
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}
