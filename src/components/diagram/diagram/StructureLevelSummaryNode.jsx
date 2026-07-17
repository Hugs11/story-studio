import { SquareStack } from '../../icons/LucideLocal';

export function StructureLevelSummaryNode({ entry, onExpand }) {
  return (
    <button
      type="button"
      className="fd-complete-node fd-structure-summary-node"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onExpand?.(entry.id);
      }}
      title={`Déplier ce dossier et afficher ses ${entry.storyCount} histoires`}
    >
      <span className="fd-structure-summary-visual" aria-hidden="true">
        <SquareStack className="fd-structure-summary-icon" />
        <span className="fd-structure-summary-meta">
          <span className="fd-structure-summary-count">{entry.storyCount}</span>
          <span className="fd-structure-summary-label">histoires</span>
        </span>
      </span>
      <span className="fd-structure-summary-action">Déplier</span>
    </button>
  );
}
