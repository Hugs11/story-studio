import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { useLocalFile } from '../../store/useLocalFile';
import { findParentMenuId, findEntryById, findEntryPath, deepCloneEntry } from '../../store/projectModel';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { useSharedClipboard } from '../../store/useSharedClipboard';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { Tooltip } from '../common/Tooltip';
import { Copy, Scissors, ClipboardPaste, Trash2, FolderPlus, Music, Image as ImageIcon, Moon, House, FilePen, Eye, Settings, Play } from '../icons/LucideLocal';
import {
  ICONS,
  TYPE_LABELS,
  MIME,
  BUTTON_ZOOM_FACTOR,
  WHEEL_ZOOM_SENSITIVITY,
  DRAG_START_DISTANCE,
  clampZoom,
  getCompleteLayout,
  getCompleteNavigationEdges,
  canMoveEntryToContainer,
  END_NODE_ID,
} from './flowDiagramLayout';

const TREE_COLOR_PALETTE = ['#e24b4a', '#ef9f27', '#f0c84b', '#5fbf6b', '#3d9be9', '#7c6af7', '#d95bb4'];

function useZipCover(zipPath, coverImage) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!zipPath || !coverImage) {
      setUrl(null);
      return undefined;
    }

    let cancelled = false;
    let objectUrl = null;
    const assetName = `assets/${coverImage}`;

    invoke('get_pack_asset', { zipPath, assetName })
      .then((bytes) => {
        if (cancelled) return;
        const ext = coverImage.split('.').pop().toLowerCase();
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'image/png' }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [zipPath, coverImage]);

  return url;
}

function FullDiagramNode({
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
  const imagePath = isRoot
    ? (rootImage ?? null)
    : entry.type === 'menu'
      ? entry.image ?? null
      : entry.type === 'story'
        ? entry.itemImage ?? null
        : null;
  const zipCoverImage = entry.type === 'zip' ? entry.coverImage ?? null : null;
  const zipPath = entry.type === 'zip' ? entry.zipPath ?? null : null;
  const localUrl = useLocalFile(imagePath);
  const zipUrl = useZipCover(zipPath, zipCoverImage);
  const compact = compactMode !== 'full';
  const showThumbnail = !compact || entry.type === 'story';
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
          : <span className="fd-complete-node-placeholder">{ICONS[entry.type]}</span>}
        {sequenceCount > 0 ? <span className="fd-complete-end-badge">Fin x{sequenceCount}</span> : null}
        {dropLabel ? <div className="fd-complete-drop-indicator">{dropLabel}</div> : null}
      </div>
      <div className="fd-complete-node-label">
        <span className="fd-complete-node-icon">{ICONS[entry.type]}</span>
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

function FullChildrenRow({
  entries,
  compactMode,
  selectedId,
  selectedIds,
  cutIds,
  draggingId,
  dragOverContainerId,
  onSelect,
  onSelectionChange,
  onContextMenu,
  onPreview,
  onInspect,
  onDragPointerDown,
}) {
  if (!entries.length) return null;

  return (
    <div className="fd-complete-children-group">
      <div className="fd-complete-children-row">
        {entries.map((child) => (
          <div key={child.id} className="fd-complete-row-item">
            {child.type === 'story' ? (
              <FullDiagramNode
                entry={child}
                compactMode={compactMode}
                selectedId={selectedId}
                selectedIds={selectedIds}
                cutIds={cutIds}
                draggingId={draggingId}
                dragOverContainerId={dragOverContainerId}
                onSelect={onSelect}
                onSelectionChange={onSelectionChange}
                onContextMenu={onContextMenu}
                onPreview={onPreview}
                onInspect={onInspect}
                onDragPointerDown={onDragPointerDown}
              />
            ) : (
              <FullEntryBranch
                entry={child}
                compactMode={compactMode}
                selectedId={selectedId}
                selectedIds={selectedIds}
                cutIds={cutIds}
                draggingId={draggingId}
                dragOverContainerId={dragOverContainerId}
                onSelect={onSelect}
                onSelectionChange={onSelectionChange}
                onContextMenu={onContextMenu}
                onPreview={onPreview}
                onInspect={onInspect}
                onDragPointerDown={onDragPointerDown}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function FullEntryBranch({
  entry,
  compactMode,
  selectedId,
  selectedIds,
  cutIds,
  draggingId,
  dragOverContainerId,
  onSelect,
  onSelectionChange,
  onContextMenu,
  onPreview,
  onInspect,
  onDragPointerDown,
  rootImage,
}) {
  const structuralChildren = entry.type === 'menu'
    ? (entry.children ?? []).filter((child) => child.type === 'menu' || child.type === 'zip')
    : [];
  const storyChildren = entry.type === 'menu'
    ? (entry.children ?? []).filter((child) => child.type === 'story')
    : [];
  const hasChildren = structuralChildren.length > 0 || storyChildren.length > 0;

  return (
    <div className={`fd-complete-branch fd-complete-branch--${entry.type}`}>
      <div className="fd-complete-branch-node">
        <FullDiagramNode
          entry={entry}
          compactMode={compactMode}
          selectedId={selectedId}
          selectedIds={selectedIds}
          cutIds={cutIds}
          draggingId={draggingId}
          dragOverContainerId={dragOverContainerId}
          onSelect={onSelect}
          onSelectionChange={onSelectionChange}
          onContextMenu={onContextMenu}
          onPreview={onPreview}
          onInspect={onInspect}
          onDragPointerDown={onDragPointerDown}
          rootImage={rootImage}
        />
      </div>

      {hasChildren ? (
        <div className="fd-complete-branch-children">
          <FullChildrenRow
            entries={structuralChildren}
            compactMode={compactMode}
            selectedId={selectedId}
            selectedIds={selectedIds}
            cutIds={cutIds}
            draggingId={draggingId}
            dragOverContainerId={dragOverContainerId}
            onSelect={onSelect}
            onSelectionChange={onSelectionChange}
            onContextMenu={onContextMenu}
            onPreview={onPreview}
            onInspect={onInspect}
            onDragPointerDown={onDragPointerDown}
          />
          <FullChildrenRow
            entries={storyChildren}
            compactMode={compactMode}
            selectedId={selectedId}
            selectedIds={selectedIds}
            cutIds={cutIds}
            draggingId={draggingId}
            dragOverContainerId={dragOverContainerId}
            onSelect={onSelect}
            onSelectionChange={onSelectionChange}
            onContextMenu={onContextMenu}
            onPreview={onPreview}
            onInspect={onInspect}
            onDragPointerDown={onDragPointerDown}
          />
        </div>
      ) : null}
    </div>
  );
}

function hasSelectedAncestor(entryId, candidateIds, getParentId) {
  let parentId = getParentId(entryId);
  while (parentId != null) {
    if (candidateIds.has(parentId)) return true;
    parentId = getParentId(parentId);
  }
  return false;
}

function countDescendants(entry) {
  if (entry?.type !== 'menu') return 0;
  return (entry.children ?? []).reduce((count, child) => (
    count + 1 + countDescendants(child)
  ), 0);
}

function summarizeEntryList(children) {
  return {
    total: children.length,
    stories: children.filter((child) => child.type === 'story').length,
    containers: children.filter((child) => child.type === 'menu' || child.type === 'zip').length,
    descendants: children.reduce((count, child) => count + 1 + countDescendants(child), 0),
  };
}

function summarizeChildren(entry) {
  const children = entry?.type === 'menu' ? (entry.children ?? []) : [];
  return summarizeEntryList(children);
}

function buildChildSummaryMap(entries, map = new Map(), includeRoot = true) {
  if (includeRoot) map.set('root', summarizeEntryList(entries ?? []));
  for (const entry of entries ?? []) {
    if (entry.type === 'menu') {
      map.set(entry.id, summarizeChildren(entry));
      buildChildSummaryMap(entry.children ?? [], map, false);
    }
  }
  return map;
}

function cloneFocusedPath(path, index = 0) {
  const entry = path[index];
  if (!entry) return null;
  if (index >= path.length - 1) {
    return entry.type === 'menu'
      ? { ...entry, children: entry.children ?? [] }
      : { ...entry };
  }
  const focusedChild = cloneFocusedPath(path, index + 1);
  return {
    ...entry,
    children: focusedChild ? [focusedChild] : [],
  };
}

function buildFocusProject(project, selectedId, projectIndex) {
  if (!selectedId || selectedId === 'root' || selectedId === END_NODE_ID) return project;
  const path = findEntryPath(project, selectedId, projectIndex) ?? [];
  if (!path.length) return project;
  const focusedEntry = cloneFocusedPath(path);
  if (!focusedEntry) return project;
  return {
    ...project,
    rootEntries: [focusedEntry],
  };
}

export function CompleteDiagramTree({
  project,
  projectIndex,
  selectedId,
  selectedIds,
  onSelect,
  onSelectionChange,
  onPreview,
  onInspect,
  onMoveToMenu,
  onImportStories,
  onAddMenu,
  onAddStory,
  onUnpackZip,
  onSimulateZip,
  onSetMenuAsRoot,
  onDeleteMenu,
  onDeleteItem,
  onBulkDeleteItems,
  onBulkUpdateItems,
  onSetNodeColor,
  onPasteEntries,
  onCutPasteEntries,
  onDuplicate,
  onAddEndNode,
  onRemoveEndNode,
  allMenus,
}) {
  const containerRef = useRef(null);
  const panStateRef = useRef({ active: false, pointerId: null, startX: 0, startY: 0, cameraX: 0, cameraY: 0 });
  const didInitialCenterRef = useRef(false);
  const zoomRef = useRef(1);
  const cameraRef = useRef({ x: 0, y: 0 });
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [camera, setCamera] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverContainerId, setDragOverContainerId] = useState(undefined);
  const [dragPointerId, setDragPointerId] = useState(null);
  const draggingIdRef = useRef(null);
  const dragOverContainerIdRef = useRef(undefined);
  const dragStartRef = useRef({ pointerId: null, entryId: null, startX: 0, startY: 0 });
  const dragPointerRef = useRef({ pointerId: null, x: 0, y: 0 });
  const [dragPointer, setDragPointer] = useState(null);
  const [showReturns, setShowReturns] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const projectRef = useRef(project);
  const projectIndexRef = useRef(projectIndex);
  const onMoveToMenuRef = useRef(onMoveToMenu);
  const onSelectRef = useRef(onSelect);
  const selectedIdsRef = useRef(selectedIds);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const kbHandlersRef = useRef(null);

  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, nodeId, nodeType }
  const [cutIds, setCutIds] = useState(new Set());
  const clipboardRef = useSharedClipboard();

  const toggleCollapse = useCallback((entryId) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);

  projectRef.current = project;
  projectIndexRef.current = projectIndex;
  onMoveToMenuRef.current = onMoveToMenu;
  onSelectRef.current = onSelect;
  selectedIdsRef.current = selectedIds;
  onSelectionChangeRef.current = onSelectionChange;
  kbHandlersRef.current = { handleCopy, handleCut, handlePaste, handleDeleteSelection, selectedId };

  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      const actionId = findShortcutAction(e, getCurrentShortcuts(), 'diagram');
      if (!actionId) return;
      const { handleCopy: copy, handleCut: cut, handlePaste: paste, handleDeleteSelection: del, selectedId: sid } = kbHandlersRef.current;
      e.preventDefault();
      if (actionId === 'diagramCopy') copy(sid);
      else if (actionId === 'diagramCut') cut(sid);
      else if (actionId === 'diagramPaste') paste(sid);
      else if (actionId === 'diagramDelete') del(sid);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const node = containerRef.current;
    const update = () => {
      setContainerWidth(node.clientWidth || 0);
      setContainerHeight(node.clientHeight || 0);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const handleZoom = useCallback((scaleFactor, focusPoint = null) => {
    const node = containerRef.current;
    const currentZoom = zoomRef.current || 1;
    const nextZoom = clampZoom(currentZoom * scaleFactor);
    if (!node || nextZoom === currentZoom) return;

    const clientX = focusPoint?.x ?? (node.clientWidth / 2);
    const clientY = focusPoint?.y ?? (node.clientHeight / 2);
    const currentCamera = cameraRef.current;

    const worldX = (clientX - currentCamera.x) / currentZoom;
    const worldY = (clientY - currentCamera.y) / currentZoom;
    const nextCamera = {
      x: clientX - (worldX * nextZoom),
      y: clientY - (worldY * nextZoom),
    };

    zoomRef.current = nextZoom;
    cameraRef.current = nextCamera;
    didInitialCenterRef.current = true;
    setCamera(nextCamera);
    setZoom(nextZoom);
  }, []);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    function handleWheel(event) {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const scaleFactor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      handleZoom(scaleFactor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }

    node.addEventListener('wheel', handleWheel, { passive: false });
    return () => node.removeEventListener('wheel', handleWheel);
  }, [handleZoom]);

  const compactMode = useMemo(() => {
    if (containerWidth > 0 && containerWidth < 900) return 'minimal';
    if (containerWidth > 0 && containerWidth < 1400) return 'compact';
    return 'full';
  }, [containerWidth]);
  const visibleProject = useMemo(
    () => (focusMode ? buildFocusProject(project, selectedId, projectIndex) : project),
    [focusMode, project, projectIndex, selectedId],
  );
  const childSummaryById = useMemo(
    () => buildChildSummaryMap(project.rootEntries ?? []),
    [project.rootEntries],
  );
  const layout = useMemo(
    () => getCompleteLayout(visibleProject, compactMode, { collapsedIds }),
    [visibleProject, compactMode, collapsedIds],
  );
  const allNavigationEdges = useMemo(() => getCompleteNavigationEdges(visibleProject, layout), [visibleProject, layout]);
  const navigationEdges = useMemo(() => {
    if (!showReturns) return [];
    if (focusMode) {
      return allNavigationEdges.filter((edge) => (
        edge.from === selectedId || edge.to === selectedId
      ));
    }
    return allNavigationEdges;
  }, [allNavigationEdges, focusMode, selectedId, showReturns]);
  const returnEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'return'), [navigationEdges]);
  const homeEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'home'), [navigationEdges]);
  const sequenceEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'sequence'), [navigationEdges]);
  useEffect(() => {
    didInitialCenterRef.current = false;
  }, [project, focusMode, collapsedIds]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    cameraRef.current = camera;
  }, [camera]);

  useEffect(() => {
    draggingIdRef.current = draggingId;
  }, [draggingId]);

  useEffect(() => {
    dragOverContainerIdRef.current = dragOverContainerId;
  }, [dragOverContainerId]);

  const clearDragState = useCallback(() => {
    draggingIdRef.current = null;
    dragOverContainerIdRef.current = undefined;
    dragStartRef.current = { pointerId: null, entryId: null, startX: 0, startY: 0 };
    dragPointerRef.current = { pointerId: null, x: 0, y: 0 };
    setDragPointerId(null);
    setDraggingId(null);
    setDragOverContainerId(undefined);
    setDragPointer(null);
  }, []);

  useEffect(() => {
    if (dragPointerId == null) return undefined;

    function updateDropTarget(clientX, clientY, activeId) {
      const hit = document.elementFromPoint(clientX, clientY);
      const dropNode = hit?.closest?.('[data-fd-drop-container]');
      if (!dropNode) {
        dragOverContainerIdRef.current = undefined;
        setDragOverContainerId(undefined);
        return;
      }
      const rawId = dropNode.getAttribute('data-fd-drop-container');
      const containerId = rawId === 'root' ? null : rawId;
      if (!canMoveEntryToContainer(projectRef.current, projectIndexRef.current, activeId, containerId)) {
        dragOverContainerIdRef.current = undefined;
        setDragOverContainerId(undefined);
        return;
      }
      dragOverContainerIdRef.current = containerId;
      setDragOverContainerId(containerId);
    }

    function handleWindowPointerMove(event) {
      if (event.pointerId !== dragStartRef.current.pointerId) return;
      const activeId = draggingIdRef.current ?? dragStartRef.current.entryId;
      if (!activeId) return;

      if (!draggingIdRef.current) {
        const deltaX = event.clientX - dragStartRef.current.startX;
        const deltaY = event.clientY - dragStartRef.current.startY;
        if (Math.hypot(deltaX, deltaY) < DRAG_START_DISTANCE) return;
        draggingIdRef.current = dragStartRef.current.entryId;
        setDraggingId(dragStartRef.current.entryId);
      }

      dragPointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      setDragPointer({ x: event.clientX, y: event.clientY });
      updateDropTarget(event.clientX, event.clientY, activeId);
      event.preventDefault();
    }

    function handleWindowPointerUp(event) {
      if (event.pointerId !== dragStartRef.current.pointerId) return;
      const activeId = draggingIdRef.current;
      const targetContainerId = dragOverContainerIdRef.current;
      if (activeId && targetContainerId !== undefined) {
        const currentSelectedIds = selectedIdsRef.current;
        const idsToMove = (currentSelectedIds?.has(activeId) && currentSelectedIds?.size > 1)
          ? [...currentSelectedIds]
          : [activeId];
        const snapshot = projectRef.current;
        const snapshotIndex = projectIndexRef.current;
        for (const id of idsToMove) {
          if (canMoveEntryToContainer(snapshot, snapshotIndex, id, targetContainerId)) {
            const fromContainerId = findParentMenuId(snapshot, id, snapshotIndex);
            onMoveToMenuRef.current?.(id, fromContainerId, targetContainerId);
          }
        }
        onSelectRef.current?.(activeId);
      }
      clearDragState();
      event.preventDefault();
    }

    function handleWindowPointerCancel(event) {
      if (event.pointerId !== dragStartRef.current.pointerId) return;
      clearDragState();
    }

    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerCancel);

    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerCancel);
    };
  }, [clearDragState, dragPointerId]);

  useLayoutEffect(() => {
    if (didInitialCenterRef.current || !containerWidth || !containerHeight) return;
    const currentZoom = zoomRef.current;
    const targetX = Math.round((containerWidth - (layout.width * currentZoom)) / 2);
    const targetY = Math.round(Math.max(40, (containerHeight - (layout.height * currentZoom)) / 6));
    const nextCamera = { x: targetX, y: targetY };
    cameraRef.current = nextCamera;
    setCamera(nextCamera);
    didInitialCenterRef.current = true;
  }, [containerWidth, containerHeight, layout.height, layout.width]);

  const stopPanning = useCallback((pointerId) => {
    const node = containerRef.current;
    if (node && pointerId != null && node.hasPointerCapture?.(pointerId)) {
      node.releasePointerCapture(pointerId);
    }
    panStateRef.current = { active: false, pointerId: null, startX: 0, startY: 0, cameraX: 0, cameraY: 0 };
    setIsPanning(false);
  }, []);

  function handlePointerDown(event) {
    if (event.button !== 0) return;
    if (event.target.closest('.fd-complete-node, .fd-complete-zoom, .fd-complete-viewbar')) return;
    const node = containerRef.current;
    if (!node) return;
    panStateRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      cameraX: cameraRef.current.x,
      cameraY: cameraRef.current.y,
    };
    node.setPointerCapture?.(event.pointerId);
    setIsPanning(true);
    event.preventDefault();
  }

  function handlePointerMove(event) {
    const panState = panStateRef.current;
    const node = containerRef.current;
    if (!panState.active || !node) return;
    const deltaX = event.clientX - panState.startX;
    const deltaY = event.clientY - panState.startY;
    const nextCamera = {
      x: panState.cameraX + deltaX,
      y: panState.cameraY + deltaY,
    };
    cameraRef.current = nextCamera;
    setCamera(nextCamera);
    event.preventDefault();
  }

  function handleDragPointerDown(event, entryId) {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    dragStartRef.current = {
      pointerId: event.pointerId,
      entryId,
      startX: event.clientX,
      startY: event.clientY,
    };
    dragPointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setDragPointerId(event.pointerId);
    // Preserve multi-selection when dragging an already-selected node
    const currentIds = selectedIdsRef.current;
    if (currentIds?.has(entryId) && currentIds?.size > 1) {
      onSelectionChangeRef.current?.(currentIds); // sets skipIdSyncRef in DiagramTab
    }
    onSelect?.(entryId);
  }

  const handleContextMenu = useCallback((e, nodeId, nodeType) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIds?.has(nodeId)) {
      onSelectionChange?.(new Set([nodeId]));
      onSelect?.(nodeId);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, nodeType });
  }, [selectedIds, onSelectionChange, onSelect]);

  function getTopLevelSelected(nodeId) {
    const ids = (nodeId && !selectedIds?.has(nodeId))
      ? [nodeId]
      : [...(selectedIds ?? [])].filter((id) => id !== 'root' && id !== END_NODE_ID);
    const idSet = new Set(ids);
    const getParentId = (id) => findParentMenuId(project, id, projectIndex) ?? null;
    return ids.filter((id) => !hasSelectedAncestor(id, idSet, getParentId));
  }

  function getPasteTargetId(nodeId) {
    if (!nodeId || nodeId === 'root') return null;
    const entry = findEntryById(project, nodeId, projectIndex);
    if (entry?.type === 'menu') return nodeId;
    return findParentMenuId(project, nodeId, projectIndex) ?? null;
  }

  function handleCopy(nodeId) {
    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    clipboardRef.current = {
      entries: topLevel.map((id) => deepCloneEntry(findEntryById(project, id, projectIndex))).filter(Boolean),
      isCut: false,
      sourceIds: topLevel,
    };
    setCutIds(new Set());
  }

  function handleCut(nodeId) {
    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    clipboardRef.current = {
      entries: topLevel.map((id) => findEntryById(project, id, projectIndex)).filter(Boolean),
      isCut: true,
      sourceIds: topLevel,
    };
    setCutIds(new Set(topLevel));
  }

  function handlePaste(nodeId) {
    if (!clipboardRef.current?.entries?.length) return;
    const { entries, isCut, sourceIds } = clipboardRef.current;
    const targetId = getPasteTargetId(nodeId ?? selectedId);
    if (isCut) {
      onCutPasteEntries?.(sourceIds, targetId);
      clipboardRef.current = null;
      setCutIds(new Set());
    } else {
      onPasteEntries?.(targetId, entries.map((e) => deepCloneEntry(e)));
    }
  }

  function handlePasteMedia(nodeId, nodeType, kind) {
    const clipboard = kind === 'image' ? imageClipboard : audioClipboard;
    const clip = clipboard.getEntry();
    if (!clip?.path) return;
    document.dispatchEvent(new CustomEvent('media-drop-node', {
      detail: {
        nodeId,
        nodeType,
        path: clip.path,
        paths: clip.paths,
        kind,
        clipboardMode: clip.mode,
      },
    }));
    if (clip.mode === 'cut') clipboard.clear();
  }

  function handleDeleteSelection(nodeId) {
    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    onBulkDeleteItems?.(topLevel);
    onSelectionChange?.(new Set(['root']));
    onSelect?.('root');
  }

  function buildActions(nodeId, nodeType) {
    if (nodeId === END_NODE_ID) {
      return [{ icon: <Trash2 />, label: 'Supprimer le nœud de fin', fn: () => onRemoveEndNode?.(), danger: true }];
    }

    const entry = findEntryById(project, nodeId, projectIndex);
    const menuId = nodeType === 'menu'
      ? nodeId
      : (findParentMenuId(project, nodeId, projectIndex) ?? null);
    const actions = [];

    actions.push({ icon: <FolderPlus />, label: 'Ajouter un dossier', fn: () => onAddMenu?.(menuId) });
    actions.push({ icon: <Music />, label: 'Importer des histoires', fn: () => onAddStory?.(menuId) });

    const hasEndNode = !!(project.nightModeAudio || project.globalOptions?.nightMode || project.globalOptions?.endNode);
    if (nodeType === 'root' && !hasEndNode) {
      actions.push('sep');
      actions.push({ icon: <Moon />, label: 'Ajouter un nœud de fin', fn: () => onAddEndNode?.() });
    }

    if (nodeType === 'menu' && onSetMenuAsRoot && project.rootEntries?.[0]?.id === nodeId) {
      actions.push('sep');
      actions.push({ icon: <House />, label: 'Définir comme racine', fn: () => onSetMenuAsRoot(nodeId) });
    }

    if (nodeType === 'zip' && entry?.zipPath) {
      actions.push('sep');
      actions.push({ icon: <Play />, label: 'Simuler ce pack…', fn: () => onSimulateZip?.(entry.zipPath) });
      actions.push({ icon: <FilePen />, label: "Extraire l'histoire", fn: () => onUnpackZip?.(nodeId) });
    }

    if ((nodeType === 'zip' || nodeType === 'story' || nodeType === 'menu') && menuId != null) {
      actions.push('sep');
      actions.push({ icon: '↖', label: 'Sortir du dossier', fn: () => onMoveToMenu?.(nodeId, menuId, null) });
    }

    if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
      actions.push('sep');
      actions.push({ icon: '⧉', label: 'Dupliquer', fn: () => onDuplicate?.(nodeId) });
      actions.push({ icon: <Copy />, label: 'Copier', fn: () => handleCopy(nodeId) });
      actions.push({ icon: <Scissors />, label: 'Couper', fn: () => handleCut(nodeId) });
    }

    if (clipboardRef.current?.entries?.length) {
      if (!actions.some((a) => a === 'sep')) actions.push('sep');
      actions.push({ icon: <ClipboardPaste />, label: 'Coller ici', fn: () => handlePaste(nodeId) });
    }

    if ((nodeType === 'root' || nodeType === 'menu' || nodeType === 'story') && audioClipboard.get()) {
      const audioClip = audioClipboard.getEntry();
      const audioCount = audioClip?.paths?.length ?? 1;
      if (!actions.some((a) => a === 'sep')) actions.push('sep');
      actions.push({
        icon: <Music />,
        label: audioClip?.mode === 'cut'
          ? (audioCount > 1 ? `Déplacer ${audioCount} sons ici` : "Déplacer l'audio ici")
          : (audioCount > 1 ? `Coller ${audioCount} sons ici` : "Coller l'audio ici"),
        fn: () => handlePasteMedia(nodeId, nodeType, 'audio'),
      });
    }

    if ((nodeType === 'root' || nodeType === 'menu' || nodeType === 'story') && imageClipboard.get()) {
      if (!actions.some((a) => a === 'sep')) actions.push('sep');
      actions.push({
        icon: <ImageIcon />,
        label: imageClipboard.getEntry()?.mode === 'cut' ? "Déplacer l'image ici" : "Coller l'image ici",
        fn: () => handlePasteMedia(nodeId, nodeType, 'image'),
      });
    }

    if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
      actions.push('sep');
      const selectedForDelete = selectedIds?.has(nodeId) && selectedIds?.size > 1
        ? getTopLevelSelected(nodeId)
        : [nodeId];
      const deleteFn = selectedForDelete.length > 1
        ? () => handleDeleteSelection(nodeId)
        : nodeType === 'menu'
          ? () => onDeleteMenu?.(nodeId)
          : () => onDeleteItem?.(nodeId);
      actions.push({
        icon: <Trash2 />,
        label: selectedForDelete.length > 1 ? `Supprimer ${selectedForDelete.length} éléments` : 'Supprimer',
        fn: deleteFn,
        danger: true,
      });
    }

    if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
      const isMultiTarget = selectedIds?.has(nodeId) && selectedIds?.size > 1;
      const colorTargetIds = isMultiTarget
        ? getTopLevelSelected(nodeId).filter((id) => id !== 'root')
        : [nodeId];
      const includesRoot = isMultiTarget && selectedIds?.has('root');

      let currentColor;
      if (isMultiTarget) {
        const colors = colorTargetIds.map((id) => findEntryById(project, id, projectIndex)?.treeColor ?? null);
        if (includesRoot) colors.push(project.treeColor ?? null);
        const unique = [...new Set(colors)];
        currentColor = unique.length === 1 ? unique[0] : '__mixed__';
      } else {
        currentColor = entry?.treeColor ?? null;
      }

      const applyColor = (color) => {
        if (isMultiTarget) {
          if (colorTargetIds.length > 0) {
            onBulkUpdateItems?.(colorTargetIds, () => ({ treeColor: color }));
          }
          if (includesRoot) {
            onSetNodeColor?.('root', 'root', color);
          }
        } else {
          onSetNodeColor?.(nodeId, nodeType, color);
        }
      };

      const headerLabel = isMultiTarget
        ? `Couleur (${colorTargetIds.length + (includesRoot ? 1 : 0)} éléments)`
        : 'Couleur';

      actions.push('sep');
      actions.push({
        type: 'node',
        render: () => (
          <div className="ctx-color-section">
            <div className="ctx-color-header">{headerLabel}</div>
            <div className="ctx-color-row">
              {TREE_COLOR_PALETTE.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`ctx-color-dot${currentColor === color ? ' is-active' : ''}`}
                  style={{ backgroundColor: color }}
                  title={color}
                  onClick={() => {
                    applyColor(color);
                    setCtxMenu(null);
                  }}
                />
              ))}
              <button
                type="button"
                className={`ctx-color-clear${currentColor === null ? ' is-active' : ''}`}
                title={currentColor === '__mixed__' ? 'Couleurs différentes — cliquer pour effacer' : 'Aucune couleur'}
                onClick={() => {
                  applyColor(null);
                  setCtxMenu(null);
                }}
              >
                ×
              </button>
            </div>
          </div>
        ),
      });
    }

    return actions;
  }

  return (
    <div className="fd-complete-shell">
      <div
        ref={containerRef}
        className={`fd-complete-stage ${isPanning ? 'is-panning' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => stopPanning(event.pointerId)}
        onPointerCancel={(event) => stopPanning(event.pointerId)}
        onLostPointerCapture={(event) => stopPanning(event.pointerId)}
      >
        <div className="fd-complete-viewbar" aria-label="Modes du diagramme">
          <label className="fd-complete-toggle">
            <input
              type="checkbox"
              checked={showReturns}
              onChange={(event) => setShowReturns(event.target.checked)}
            />
            <span>Afficher les retours</span>
          </label>
          <button
            type="button"
            className={`fd-complete-mode-btn ${focusMode ? 'is-active' : ''}`}
            onClick={() => setFocusMode((current) => !current)}
          >
            Focus branche
          </button>
          {collapsedIds.size > 0 ? (
            <button
              type="button"
              className="fd-complete-clear-collapse"
              onClick={() => setCollapsedIds(new Set())}
            >
              Tout ouvrir
            </button>
          ) : null}
        </div>
        <div className="fd-complete-zoom">
          <button type="button" className="fd-complete-zoom-btn" onClick={() => handleZoom(BUTTON_ZOOM_FACTOR)}>+</button>
          <div className="fd-complete-zoom-value">{Math.round(zoom * 100)}%</div>
          <button type="button" className="fd-complete-zoom-btn" onClick={() => handleZoom(1 / BUTTON_ZOOM_FACTOR)}>−</button>
        </div>

        <div className="fd-complete-viewport">
          <div
            className={`fd-complete-canvas fd-complete-canvas--${compactMode}`}
            style={{
              '--fd-node-width': `${layout.metrics.nodeWidth}px`,
              '--fd-node-root-width': `${layout.metrics.rootWidth}px`,
              width: layout.width,
              height: layout.height,
              transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})`,
            }}
          >
            <svg className="fd-complete-lines" width={layout.width} height={layout.height} aria-hidden="true">
              {(layout.groups ?? []).map((group) => (
                <rect
                  key={`${group.parentId}-${group.kind}-${group.x}-${group.y}`}
                  className={`fd-complete-sibling-group fd-complete-sibling-group--${group.kind} fd-complete-sibling-group--tone-${group.tone ?? 0}`}
                  x={group.x}
                  y={group.y}
                  width={group.width}
                  height={group.height}
                  rx="12"
                />
              ))}
              {layout.edges.map((edge) => (
                <path
                  key={`${edge.from}-${edge.to}`}
                  className={`fd-complete-line fd-complete-line--${edge.kind || 'structural'}`}
                  d={`M ${edge.x1} ${edge.y1} L ${edge.x1} ${edge.midY} L ${edge.x2} ${edge.midY} L ${edge.x2} ${edge.y2}`}
                />
              ))}
              {navigationEdges.map((edge) => (
                <path
                  key={`${edge.kind}-${edge.source || 'configured'}-${edge.from}-${edge.to}`}
                  className={`fd-complete-line fd-complete-line--${edge.kind} fd-complete-line--${edge.source || 'configured'} ${selectedId === edge.from || selectedId === edge.to ? 'is-related' : ''}`}
                  d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.c1y} ${edge.x2} ${edge.c2y} ${edge.x2} ${edge.y2}`}
                />
              ))}
              {navigationEdges.filter((edge) => edge.label).map((edge) => (
                <text
                  key={`label-${edge.kind}-${edge.source || 'configured'}-${edge.from}-${edge.to}`}
                  className={`fd-complete-edge-label fd-complete-edge-label--${edge.kind}`}
                  x={edge.labelX}
                  y={edge.labelY}
                  textAnchor="middle"
                >
                  {edge.label}
                </text>
              ))}
            </svg>

            {layout.nodes.map((node) => (
              <div
                key={node.entry.id}
                className="fd-complete-placed-node"
                style={{ left: node.x, top: node.y, width: node.width }}
              >
                <FullDiagramNode
                  entry={node.entry}
                  compactMode={compactMode}
                  selectedId={selectedId}
                  selectedIds={selectedIds}
                  cutIds={cutIds}
                  draggingId={draggingId}
                  dragOverContainerId={dragOverContainerId}
                  onSelect={onSelect}
                  onSelectionChange={onSelectionChange}
                  onContextMenu={handleContextMenu}
                  onPreview={onPreview}
                  onInspect={onInspect}
                  onDragPointerDown={handleDragPointerDown}
                  onToggleCollapse={toggleCollapse}
                  isRoot={node.entry.id === 'root'}
                  rootImage={project.rootImage}
                  isCollapsed={collapsedIds.has(node.entry.id)}
                  childSummary={childSummaryById.get(node.entry.id) ?? null}
                />
              </div>
            ))}
          </div>
        </div>
        <div className="fd-stage-legend" aria-label="Légende du diagramme">
          <div className="fd-complete-legend-item">
            <span className="fd-complete-legend-line" />
            <span>Structure principale</span>
          </div>
          {returnEdges.length > 0 ? (
            <div className="fd-complete-legend-item">
              <span className="fd-complete-legend-line fd-complete-legend-line--return" />
              <span>Retours</span>
            </div>
          ) : null}
          {homeEdges.length > 0 ? (
            <div className="fd-complete-legend-item">
              <span className="fd-complete-legend-line fd-complete-legend-line--home" />
              <span>Retours modifiés</span>
            </div>
          ) : null}
          {sequenceEdges.length > 0 ? (
            <div className="fd-complete-legend-item">
              <span className="fd-complete-legend-line fd-complete-legend-line--sequence" />
              <span>Sequences de fin</span>
            </div>
          ) : null}
        </div>
        {dragPointer && draggingId ? (
          <div
            className="fd-complete-drag-ghost"
            style={{ left: dragPointer.x + 14, top: dragPointer.y + 14 }}
          >
            Deplacer
          </div>
        ) : null}
      </div>

      {ctxMenu && createPortal(
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          actions={buildActions(ctxMenu.nodeId, ctxMenu.nodeType)}
        />,
        document.body,
      )}
    </div>
  );
}
