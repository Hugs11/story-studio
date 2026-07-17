import { Focus, IterationCcw, SquareStack } from '../../icons/LucideLocal';

export function DiagramViewToggles({
  showReturns,
  onShowReturnsChange,
  focusMode,
  onFocusModeToggle,
  canFocusBranch,
  hasExpandedStoryGroups,
  onCollapseAllStories,
}) {
  return (
    <div className="fd-complete-viewbar" aria-label="Modes du diagramme">
      <button
        type="button"
        className={`fd-diagram-option ${showReturns ? 'is-active' : ''}`}
        aria-label="Afficher les liens de retour"
        aria-pressed={showReturns}
        title="Afficher les liens de retour"
        onClick={() => onShowReturnsChange(!showReturns)}
      >
        <IterationCcw />
        <span className="fd-ctrl-label">Retours</span>
      </button>
      <button
        type="button"
        className={`fd-diagram-option ${focusMode ? 'is-active' : ''}`}
        aria-label={canFocusBranch ? 'Limiter la vue à la branche du nœud sélectionné' : 'Sélectionne un nœud pour focaliser sa branche'}
        aria-pressed={focusMode}
        title={canFocusBranch ? 'Limiter la vue à la branche du nœud sélectionné' : 'Sélectionne un nœud pour focaliser sa branche'}
        disabled={!canFocusBranch}
        onClick={onFocusModeToggle}
      >
        <Focus />
        <span className="fd-ctrl-label fd-ctrl-label--full">Focus branche</span>
        <span className="fd-ctrl-label fd-ctrl-label--short">Focus</span>
      </button>
      {hasExpandedStoryGroups ? (
        <button
          type="button"
          className="fd-diagram-option"
          aria-label="Tout replier"
          title="Replier tous les dossiers d’histoires"
          onClick={onCollapseAllStories}
        >
          <SquareStack />
          <span className="fd-ctrl-label fd-ctrl-label--full">Tout replier</span>
          <span className="fd-ctrl-label fd-ctrl-label--short">Replier</span>
        </button>
      ) : null}
    </div>
  );
}
