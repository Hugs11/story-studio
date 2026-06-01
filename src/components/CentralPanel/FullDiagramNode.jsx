// Noeud unitaire du diagramme complet (story, menu, zip, root, end-node).
// Extrait de FullDiagramTree.jsx pour reduire la surface de l'orchestrateur.

import { useLocalFile } from '../../hooks/useLocalFile';
import { getEntryThumbnailPath } from '../../store/projectModel';
import { Tooltip } from '../common/Tooltip';
import { Eye, Settings } from '../icons/LucideLocal';
import { IconArchive, IconFolderOpen, IconHouse, IconMoon, IconStop, IconStory } from '../TreePanel/TreeIcons';
import { TYPE_LABELS, END_NODE_ID } from './flowDiagramLayout';
import { useZipCover } from './useZipCover.js';

function DiagramNodeTypeIcon({ entry }) {
  if (entry.type === 'root') return <IconHouse />;
  if (entry.type === 'menu') return <IconFolderOpen />;
  if (entry.type === 'story') return <IconStory />;
  if (entry.type === 'zip') return <IconArchive />;
  if (entry.type === 'end-node') return entry.icon === 'moon' ? <IconMoon /> : <IconStop />;
  return null;
}

export function FullDiagramNode({
  entry,
  compactMode = 'full',
  selectedId,
  selectedIds,
  cutIds,
  draggingId = null,
  dragOverContainerId = undefined,
  onSelect,
  onSelectionChange,
  onContextMenu,
  onPreview,
  onInspect,
  onDragPointerDown,
  onToggleCollapse,
  isRoot = false,
  rootImage,
  isCollapsed = false,
  childSummary = null,
}) {
  const imagePath = entry?.type === 'zip' ? null : getEntryThumbnailPath(entry, { rootImage, isRoot });
  const zipCoverImage = entry.type === 'zip' ? entry.coverImage ?? null : null;
  const zipPath = entry.type === 'zip' ? entry.zipPath ?? null : null;
  const localUrl = useLocalFile(imagePath);
  const zipUrl = useZipCover(zipPath, zipCoverImage);
  const compact = compactMode !== 'full';
  const showThumbnail = !compact || entry.type === 'story' || entry.type === 'root';
  const url = showThumbnail ? (entry.type === 'zip' ? zipUrl : localUrl) : null;
  const sequenceCount = entry.type === 'story' ? (entry.afterPlaybackSequence?.length ?? 0) : 0;
  const containerId = isRoot ? null : entry.type === 'menu' ? entry.id : undefined;
  const isDropTarget = containerId === dragOverContainerId && draggingId !== null;
  const isDragging = draggingId === entry.id;
  const isSelected = selectedIds ? selectedIds.has(entry.id) : selectedId === entry.id;
  const isCut = cutIds?.has(entry.id);
  const canCollapse = entry.type === 'menu' && childSummary?.total > 0;
  const dropLabel = isDropTarget
    ? (isRoot ? 'Deplacer a la racine' : 'Deplacer ici')
    : null;

  function handleClick(e) {
    if (entry.id === END_NODE_ID) {
      onSelectionChange?.(new Set([END_NODE_ID]));
      onSelect?.(END_NODE_ID);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.shiftKey) { // Shift = Ctrl dans le diagramme (pas de liste plate pour le range)
      const next = new Set([...(selectedIds ?? [selectedId])].filter((id) => id !== END_NODE_ID));
      if (next.has(entry.id)) {
        next.delete(entry.id);
        if (next.size === 0) next.add(entry.id);
      } else {
        next.add(entry.id);
      }
      onSelectionChange?.(next);
      onSelect?.(entry.id);
    } else {
      onSelectionChange?.(new Set([entry.id]));
      onSelect?.(entry.id);
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={`fd-complete-node fd-complete-node--${entry.type} ${isSelected ? 'is-selected' : ''} ${isDropTarget ? 'is-drop-target' : ''} ${isDragging ? 'is-dragging' : ''} ${selectedIds && selectedIds.size > 1 && isSelected ? 'is-multi-selected' : ''} ${isCut ? 'is-cut' : ''}`}
      style={isCut ? { opacity: 0.4 } : undefined}
      data-fd-drop-container={containerId === undefined ? undefined : (containerId === null ? 'root' : containerId)}
      {...((entry.type === 'story' || entry.type === 'menu' || entry.type === 'root') ? { 'data-media-node-id': entry.id, 'data-media-node-type': entry.type } : {})}
      onPointerDown={(!isRoot && entry.type !== 'end-node') ? (event) => onDragPointerDown?.(event, entry.id) : undefined}
      onClick={handleClick}
      onContextMenu={(e) => onContextMenu?.(e, entry.id, entry.type)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect?.(entry.id);
        }
      }}
      title={entry.name || '(sans nom)'}
    >
      <div className="fd-complete-node-actions">
        {canCollapse ? (
          <Tooltip text={isCollapsed ? 'Deplier ce dossier' : 'Replier ce dossier'}>
            <button
              type="button"
              className="fd-complete-node-action fd-complete-node-action--collapse"
              aria-label={isCollapsed ? 'Deplier ce dossier' : 'Replier ce dossier'}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onToggleCollapse?.(entry.id);
              }}
            >
              {isCollapsed ? '+' : '−'}
            </button>
          </Tooltip>
        ) : null}
        <Tooltip text="Simuler depuis ce point">
          <button
            type="button"
            className="fd-complete-node-action fd-complete-node-action--preview"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.(entry.id);
              onPreview?.(entry.id);
            }}
          >
            <Eye style={{ width: 16, height: 16 }} />
          </button>
        </Tooltip>
        <Tooltip text="Ouvrir les réglages de ce nœud">
          <button
            type="button"
            className="fd-complete-node-action fd-complete-node-action--inspect"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onSelectionChange?.(new Set([entry.id]));
              onSelect?.(entry.id);
              onInspect?.(entry.id);
            }}
          >
            <Settings style={{ width: 16, height: 16 }} />
          </button>
        </Tooltip>
      </div>
      <div className="fd-complete-node-thumb">
        {url
          ? <img src={url} alt="" />
          : (
            <span className={`fd-complete-node-placeholder ${entry.type === 'menu' ? 'fd-complete-node-placeholder--menu' : ''}`}>
              {entry.type === 'menu' ? null : <DiagramNodeTypeIcon entry={entry} />}
            </span>
          )}
        {sequenceCount > 0 ? <span className="fd-complete-end-badge">Fin x{sequenceCount}</span> : null}
        {dropLabel ? <div className="fd-complete-drop-indicator">{dropLabel}</div> : null}
      </div>
      <div className="fd-complete-node-label">
        <span className="fd-complete-node-icon"><DiagramNodeTypeIcon entry={entry} /></span>
        <div className="fd-complete-node-texts">
          <span className="fd-complete-node-name">{entry.name || '(sans nom)'}</span>
          {!compact ? (
            <span className="fd-complete-node-kind">
              {isCollapsed && childSummary
                ? `${TYPE_LABELS[entry.type]} · ${childSummary.descendants} element${childSummary.descendants > 1 ? 's' : ''} masques`
                : TYPE_LABELS[entry.type]}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
