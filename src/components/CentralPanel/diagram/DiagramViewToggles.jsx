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
        <span>Afficher les retours</span>
      </label>
      <button
        type="button"
        className={`fd-complete-mode-btn ${focusMode ? 'is-active' : ''}`}
        onClick={onFocusModeToggle}
      >
        Focus branche
      </button>
      {hasCollapsedNodes ? (
        <button
          type="button"
          className="fd-complete-clear-collapse"
          onClick={onOpenAll}
        >
          Tout ouvrir
        </button>
      ) : null}
    </div>
  );
}
