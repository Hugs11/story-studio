import { Focus, FolderOpen, IterationCcw, SquareStack } from '../../icons/LucideLocal';

export function DiagramViewToggles({
  showReturns,
  onShowReturnsChange,
  focusMode,
  onFocusModeToggle,
  canFocusBranch,
  hasCollapsedNodes,
  onOpenAll,
  hasExpandedStoryGroups,
  onRegroupStories,
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
      {hasCollapsedNodes ? (
        <button
          type="button"
          className="fd-diagram-option"
          aria-label="Déplier tous les dossiers"
          title="Déplier tous les dossiers"
          onClick={onOpenAll}
        >
          <FolderOpen />
          <span className="fd-ctrl-label fd-ctrl-label--full">Tout déplier</span>
          <span className="fd-ctrl-label fd-ctrl-label--short">Tout</span>
        </button>
      ) : null}
      {hasExpandedStoryGroups ? (
        <button
          type="button"
          className="fd-diagram-option"
          aria-label="Regrouper les histoires"
          title="Regrouper les histoires"
          onClick={onRegroupStories}
        >
          <SquareStack />
          <span className="fd-ctrl-label fd-ctrl-label--full">Regrouper les histoires</span>
          <span className="fd-ctrl-label fd-ctrl-label--short">Regrouper</span>
        </button>
      ) : null}
    </div>
  );
}
