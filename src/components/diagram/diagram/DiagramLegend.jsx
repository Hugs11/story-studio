import { useTreeTranslation } from '../../../i18n/useTreeTranslation.jsx';
import { translateTree as t } from '../../../i18n/treePresentation.js';
export function DiagramLegend({ returnEdges, homeEdges, afterEndEdges }) {
  useTreeTranslation();
  return (
    <div className="fd-stage-legend" aria-label={t("tree:diagram.legend.aria")}>
      <div className="fd-complete-legend-item">
        <span className="fd-complete-legend-line" />
        <span>{t("tree:diagram.legend.main")}</span>
      </div>
      {returnEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--return" />
          <span>{t("tree:diagram.legend.returns")}</span>
        </div>
      ) : null}
      {homeEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--home" />
          <span>{t("tree:diagram.legend.modified")}</span>
        </div>
      ) : null}
      {afterEndEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--after-end" />
          <span>{t("tree:diagram.legend.returns")}</span>
        </div>
      ) : null}
    </div>
  );
}
