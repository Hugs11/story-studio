export function DiagramLegend({ returnEdges, homeEdges, afterEndEdges, referenceEdges }) {
  return (
    <div className="fd-stage-legend" aria-label="Légende du diagramme">
      <div className="fd-complete-legend-item">
        <span className="fd-complete-legend-line" />
        <span>Structure principale</span>
      </div>
      {returnEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--return" />
          <span>Retours</span>
        </div>
      ) : null}
      {homeEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--home" />
          <span>Retours modifiés</span>
        </div>
      ) : null}
      {afterEndEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--after-end" />
          <span>Retours</span>
        </div>
      ) : null}
      {referenceEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--reference" />
          <span>Liens</span>
        </div>
      ) : null}
    </div>
  );
}
