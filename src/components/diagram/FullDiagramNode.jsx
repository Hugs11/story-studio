// Noeud unitaire du diagramme complet (story, menu, zip, root, end-node).
// Extrait de FullDiagramTree.jsx pour reduire la surface de l'orchestrateur.

import { useEffect, useRef, useState } from 'react';
import { useLocalFile } from '../../hooks/useLocalFile';
import { getEntryThumbnailPath } from '../../store/projectModel';
import { Tooltip } from '../common/Tooltip';
import { ChevronDown, Eye } from '../icons/LucideLocal';
import { IconArchive, IconArrowRight, IconFolderOpen, IconHouse, IconMoon, IconStop, IconStory } from '../TreePanel/TreeIcons';
import { END_NODE_ID } from './flowDiagramLayout';
import { toggleDiagramSelection } from './diagram/diagramSelection';
import { useZipCover } from '../editors/useZipCover.js';

function DiagramNodeTypeIcon({ entry }) {
  if (entry.type === 'root') return <IconHouse />;
  if (entry.type === 'menu') return <IconFolderOpen />;
  if (entry.type === 'story') return <IconStory />;
  if (entry.type === 'zip') return <IconArchive />;
  if (entry.type === 'ref') return <IconArrowRight />;
  if (entry.type === 'end-node') return entry.icon === 'moon' ? <IconMoon /> : <IconStop />;
  return null;
}

function useNearDiagramViewport(rootRef, enabled) {
  const nodeRef = useRef(null);
  const [isNear, setIsNear] = useState(false);

  useEffect(() => {
    if (!enabled || isNear) return undefined;
    const target = nodeRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') {
      setIsNear(true);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
        setIsNear(true);
        observer.disconnect();
      }
    }, {
      root: rootRef?.current ?? null,
      rootMargin: '200px',
      threshold: 0,
    });

    observer.observe(target);
    return () => observer.disconnect();
  }, [enabled, isNear, rootRef]);

  return [nodeRef, enabled && isNear];
}

export function FullDiagramNode({
  entry,
  compactMode = 'full',
  selectedId,
  selectedIds,
  hovered = false,
  cutIds,
  draggingId = null,
  dragOverContainerId = undefined,
  onSelect,
  onSelectionChange,
  onContextMenu,
  onPreview,
  onDragPointerDown,
  onRegroupStories,
  onNodeHoverChange,
  viewportRootRef,
  isRoot = false,
  rootImage,
  hasExpandedStoryGroup = false,
}) {
  const compact = compactMode !== 'full';
  const showThumbnail = !compact
    || entry.type === 'story'
    || entry.type === 'root'
    || entry.type === 'menu';
  const imagePath = entry?.type === 'zip' ? null : getEntryThumbnailPath(entry, { rootImage, isRoot });
  const zipCoverImage = entry.type === 'zip' ? entry.coverImage ?? null : null;
  const zipPath = entry.type === 'zip' ? entry.zipPath ?? null : null;
  const shouldObserveMedia = showThumbnail && !!(imagePath || (zipPath && zipCoverImage));
  const [nodeRef, isNearViewport] = useNearDiagramViewport(viewportRootRef, shouldObserveMedia);
  const shouldLoadMedia = shouldObserveMedia && isNearViewport;
  const localUrl = useLocalFile(shouldLoadMedia ? imagePath : null);
  const zipUrl = useZipCover(shouldLoadMedia ? zipPath : null, shouldLoadMedia ? zipCoverImage : null);
  const url = showThumbnail ? (entry.type === 'zip' ? zipUrl : localUrl) : null;
  const sequenceCount = entry.type === 'story' ? (entry.afterPlaybackSequence?.length ?? 0) : 0;
  const containerId = isRoot ? null : entry.type === 'menu' ? entry.id : undefined;
  const isDropTarget = containerId === dragOverContainerId && draggingId !== null;
  const isDragging = draggingId === entry.id;
  const isSelected = selectedIds ? selectedIds.has(entry.id) : selectedId === entry.id;
  const isCut = cutIds?.has(entry.id);
  const canRegroupStories = (entry.type === 'menu' || entry.type === 'root') && hasExpandedStoryGroup;
  const collapseLabel = 'Replier les histoires';
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
      const { next, nextSelectedId } = toggleDiagramSelection({ id: entry.id, selectedIds, selectedId });
      onSelectionChange?.(next);
      onSelect?.(nextSelectedId);
    } else {
      onSelectionChange?.(new Set([entry.id]));
      onSelect?.(entry.id);
    }
  }

  return (
    <div
      ref={nodeRef}
      role="button"
      tabIndex={0}
      className={`fd-complete-node fd-complete-node--${entry.type} ${isSelected ? 'is-selected' : ''} ${hovered ? 'is-linked-hover' : ''} ${isDropTarget ? 'is-drop-target' : ''} ${isDragging ? 'is-dragging' : ''} ${selectedIds && selectedIds.size > 1 && isSelected ? 'is-multi-selected' : ''} ${isCut ? 'is-cut' : ''}`}
      style={isCut ? { opacity: 0.4 } : undefined}
      data-fd-drop-container={containerId === undefined ? undefined : (containerId === null ? 'root' : containerId)}
      {...((entry.type === 'story' || entry.type === 'menu' || entry.type === 'root') ? { 'data-media-node-id': entry.id, 'data-media-node-type': entry.type } : {})}
      onPointerDown={(!isRoot && entry.type !== 'end-node') ? (event) => onDragPointerDown?.(event, entry.id) : undefined}
      onPointerEnter={() => onNodeHoverChange?.(entry.id, true)}
      onPointerLeave={() => onNodeHoverChange?.(entry.id, false)}
      onClick={handleClick}
      onContextMenu={(e) => onContextMenu?.(e, entry.id, entry.type)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          // Emettre la selection avant onSelect pour reduire une eventuelle multi
          // au seul noeud focus (l'arbre controle reflete alors le singleton).
          onSelectionChange?.(new Set([entry.id]));
          onSelect?.(entry.id);
        }
      }}
      title={entry.name || '(sans nom)'}
    >
      {canRegroupStories ? (
        <Tooltip text={collapseLabel} className="fd-complete-node-regroup-wrap">
          <button
            type="button"
            className="fd-complete-node-action fd-complete-node-action--regroup"
            aria-label={collapseLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onRegroupStories?.(entry.id);
            }}
          >
            <ChevronDown />
          </button>
        </Tooltip>
      ) : null}
      <div className="fd-complete-node-actions">
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
      </div>
      <div className="fd-complete-node-thumb">
        {entry.type === 'end-node' ? (
          <span
            className={`fd-complete-node-end-visual fd-complete-node-end-visual--${entry.icon === 'moon' ? 'night' : 'stop'}`}
            aria-hidden="true"
          >
            <DiagramNodeTypeIcon entry={entry} />
          </span>
        ) : (
          <>
            <span className="fd-complete-node-type-rail" aria-hidden="true">
              <DiagramNodeTypeIcon entry={entry} />
            </span>
            {url
              ? <img src={url} alt="" loading="lazy" decoding="async" />
              : <span className={`fd-complete-node-placeholder ${entry.type === 'menu' ? 'fd-complete-node-placeholder--menu' : ''}`} aria-hidden="true" />}
          </>
        )}
        {sequenceCount > 0 ? <span className="fd-complete-end-badge">Fin x{sequenceCount}</span> : null}
        {dropLabel ? <div className="fd-complete-drop-indicator">{dropLabel}</div> : null}
      </div>
      <div className="fd-complete-node-label">
        <div className="fd-complete-node-texts">
          <span className="fd-complete-node-name">{entry.type === 'ref' ? (entry.label?.trim() || 'Lien') : (entry.name || '(sans nom)')}</span>
        </div>
      </div>
    </div>
  );
}
