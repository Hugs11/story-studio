// Apercu visuel d'une entree pendant un drag (dnd-kit DragOverlay content).
// Extrait de TreePanel.jsx.

import { IconArchive, IconFolderOpen, IconStory } from './TreeIcons';

export function TreeDragOverlay({ entry }) {
  if (!entry) return null;
  return (
    <div className="tree-item active" style={{ opacity: 0.85, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', paddingLeft: '6px' }}>
      <span className="tree-chevron-spacer" />
      <div className="tree-item-body">
        <span className="ti-icon">
          {entry.type === 'menu' ? <IconFolderOpen /> : entry.type === 'zip' ? <IconArchive /> : <IconStory />}
        </span>
        <span className="ti-label">{entry.name}</span>
      </div>
    </div>
  );
}
