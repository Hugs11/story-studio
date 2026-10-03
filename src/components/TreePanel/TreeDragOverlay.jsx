// Apercu visuel d'une entree pendant un drag (dnd-kit DragOverlay content).
// Extrait de TreePanel.jsx.

import { NodeIcon } from '../icons/NodeIcon.jsx';
import { hierarchicalNatureOf } from '../../store/nodeIconVocabulary.js';
import { WORKSPACE_MODE_HIERARCHICAL } from '../../store/projectWorkState.js';

export function TreeDragOverlay({ entry }) {
  if (!entry) return null;
  return (
    <div className="tree-item active" style={{ opacity: 0.85, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', paddingLeft: '6px' }}>
      <span className="tree-chevron-spacer" />
      <div className="tree-item-body">
        <span className="ti-icon">
          {/* L'apercu porte le dessin de la nature transportee. Un type inconnu
              reste une histoire. */}
          <NodeIcon
            workspaceMode={WORKSPACE_MODE_HIERARCHICAL}
            nature={hierarchicalNatureOf(entry.type) ?? 'story'}
          />
        </span>
        <span className="ti-label">{entry.name}</span>
      </div>
    </div>
  );
}
