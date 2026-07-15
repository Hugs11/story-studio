import { IconStory } from '../../TreePanel/TreeIcons';

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
      title={`Ouvrir ce dossier et afficher ses ${entry.storyCount} histoires`}
    >
      <span className="fd-structure-summary-icon"><IconStory /></span>
      <span className="fd-structure-summary-count">{entry.storyCount}</span>
      <span className="fd-structure-summary-label">histoires</span>
      <span className="fd-structure-summary-action">Ouvrir</span>
    </button>
  );
}
