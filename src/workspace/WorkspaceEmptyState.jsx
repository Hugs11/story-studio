export function WorkspaceEmptyState({ onShowTree, onShowSettings, onShowDiagram }) {
  return (
    <div className="workspace-empty-state">
      <p>Aucun panneau affiché</p>
      <span>Réactive une vue pour reprendre l’édition.</span>
      <div className="workspace-empty-state-actions">
        <button type="button" onClick={onShowTree}>Arbre</button>
        <button type="button" onClick={onShowSettings}>Réglages</button>
        <button type="button" onClick={onShowDiagram}>Diagramme</button>
      </div>
    </div>
  );
}
