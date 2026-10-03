export function DiagramZoomControls({ zoomValueRef, zoom, onZoomIn, onZoomOut, onFit }) {
  return (
    <div className="fd-complete-zoom" role="group" aria-label="Zoom du diagramme">
      <button type="button" className="fd-complete-zoom-btn" onClick={onZoomIn} aria-label="Agrandir">+</button>
      <output ref={zoomValueRef} className="fd-complete-zoom-value" aria-label="Niveau de zoom">{Math.round(zoom * 100)}%</output>
      <button type="button" className="fd-complete-zoom-btn" onClick={onZoomOut} aria-label="Réduire">−</button>
      <button type="button" className="fd-complete-zoom-btn fd-complete-zoom-fit" onClick={onFit} aria-label="Cadrer tout le diagramme">⌗</button>
    </div>
  );
}
