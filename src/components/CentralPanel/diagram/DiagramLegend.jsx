export function DiagramLegend({ returnEdges, homeEdges, sequenceEdges, referenceEdges }) {
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
      {sequenceEdges.length > 0 ? (
        <div className="fd-complete-legend-item">
          <span className="fd-complete-legend-line fd-complete-legend-line--sequence" />
          <span>Sequences de fin</span>
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
