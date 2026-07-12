export function DiagramViewToggles({
  showReturns,
  onShowReturnsChange,
  focusMode,
  onFocusModeToggle,
  hasCollapsedNodes,
  onOpenAll,
}) {
  return (
    <div className="fd-complete-viewbar" aria-label="Modes du diagramme">
      <label className="fd-complete-toggle">
        <input
          type="checkbox"
          checked={showReturns}
          onChange={(event) => onShowReturnsChange(event.target.checked)}
        />
        {/* Libellés double : version longue par défaut, version courte sous
            ~500 px de colonne (voir `@container fd-diagram-header` dans
            FlowDiagram.css) pour tenir le bandeau 44 px sur une seule ligne. */}
        <span className="fd-ctrl-label fd-ctrl-label--full">Afficher les parcours</span>
        <span className="fd-ctrl-label fd-ctrl-label--short">Parcours</span>
      </label>
      <button
        type="button"
        className={`fd-complete-mode-btn ${focusMode ? 'is-active' : ''}`}
        onClick={onFocusModeToggle}
      >
        <span className="fd-ctrl-label fd-ctrl-label--full">Focus branche</span>
        <span className="fd-ctrl-label fd-ctrl-label--short">Focus</span>
      </button>
      {hasCollapsedNodes ? (
        <button
          type="button"
          className="fd-complete-clear-collapse"
          onClick={onOpenAll}
        >
          <span className="fd-ctrl-label fd-ctrl-label--full">Tout ouvrir</span>
          <span className="fd-ctrl-label fd-ctrl-label--short">Tout</span>
        </button>
      ) : null}
    </div>
  );
}
