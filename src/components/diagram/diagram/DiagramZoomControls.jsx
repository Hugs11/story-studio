import { useTreeTranslation } from '../../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../../i18n/treePresentation.js';
export function DiagramZoomControls({ zoomValueRef, zoom, onZoomIn, onZoomOut, onFit }) {
  useTreeTranslation();
  return (
    <div className="fd-complete-zoom" role="group" aria-label={t("tree:diagram.zoom.aria")}>
      <button type="button" className="fd-complete-zoom-btn" onClick={onZoomIn} aria-label={t("tree:diagram.zoom.in")}>+</button>
      <output ref={zoomValueRef} className="fd-complete-zoom-value" aria-label={t("tree:diagram.zoom.level")}>{Math.round(zoom * 100)}%</output>
      <button type="button" className="fd-complete-zoom-btn" onClick={onZoomOut} aria-label={t('tree:diagram.zoom.out')}>−</button>
      <button type="button" className="fd-complete-zoom-btn fd-complete-zoom-fit" onClick={onFit} aria-label={t("tree:diagram.zoom.fit")}>⌗</button>
    </div>
  );
}
