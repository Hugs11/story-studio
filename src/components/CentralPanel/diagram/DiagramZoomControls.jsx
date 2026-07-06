export function DiagramZoomControls({ zoomValueRef, zoom, onZoomIn, onZoomOut }) {
  return (
    <div className="fd-complete-zoom">
      <button type="button" className="fd-complete-zoom-btn" onClick={onZoomIn}>+</button>
      <div ref={zoomValueRef} className="fd-complete-zoom-value">{Math.round(zoom * 100)}%</div>
      <button type="button" className="fd-complete-zoom-btn" onClick={onZoomOut}>−</button>
    </div>
  );
}
