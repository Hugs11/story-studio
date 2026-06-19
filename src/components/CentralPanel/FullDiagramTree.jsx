import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findParentMenuId, findEntryById, deepCloneEntry } from '../../store/projectModel';
import { KEYS, read, write } from '../../store/persistentSettings';
import { logger } from '../../utils/logger';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { useSharedClipboard } from '../../hooks/useSharedClipboard';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import { ContextMenu } from '../TreePanel/ContextMenu';
import { Copy, Scissors, ClipboardPaste, Trash2, FolderPlus, Music, Image as ImageIcon, Moon, House, FilePen, Play } from '../icons/LucideLocal';
import {
  BUTTON_ZOOM_FACTOR,
  WHEEL_ZOOM_SENSITIVITY,
  DRAG_START_DISTANCE,
  clampZoom,
  getCompleteLayout,
  getCompleteNavigationEdges,
  canMoveEntryToContainer,
  END_NODE_ID,
  TYPE_LABELS,
} from './flowDiagramLayout';
import {
  TREE_COLOR_PALETTE,
  hasSelectedAncestor,
} from '../tree/treeOperations.js';
import {
  buildChildSummaryMap,
  buildFocusProject,
} from './fullDiagramFocus.js';
import { FullDiagramNode } from './FullDiagramNode.jsx';
import { StructureActionsBar } from '../structure/StructureActionsBar.jsx';

const DIAGRAM_PERF_KEY = 'storyStudio.diagramPerf';

function isDiagramPerfEnabled() {
  return read(DIAGRAM_PERF_KEY, { defaultValue: 'false' }) === 'true'
    || globalThis.__STORY_STUDIO_DIAGRAM_PERF__ === true;
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
  onImportFolder,
  onImportPodcast,
  onRecord,
  onAddMenu,
  onAddStory,
  onUnpackZip,
  onSimulateZip,
  onSimulateRoot,
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
  const { dropOnNode } = useMediaTransfer();
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const zoomValueRef = useRef(null);
  const viewportFrameRef = useRef(null);
  const viewportIdleTimerRef = useRef(null);
  const perfEnabledRef = useRef(isDiagramPerfEnabled());
  const viewportPerfRef = useRef({ wheelEvents: 0, transformFrames: 0, maxWheelDelay: 0, lastWheelAt: 0, lastLogAt: 0 });
  const layoutStatsRef = useRef({ nodes: 0, structureEdges: 0, navigationEdges: 0, groups: 0, width: 0, height: 0 });
  const panStateRef = useRef({ active: false, pointerId: null, startX: 0, startY: 0, cameraX: 0, cameraY: 0 });
  const didInitialCenterRef = useRef(false);
  const zoomRef = useRef(1);
  const cameraRef = useRef({ x: 0, y: 0 });
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverContainerId, setDragOverContainerId] = useState(undefined);
  const [dragPointerId, setDragPointerId] = useState(null);
  const draggingIdRef = useRef(null);
  const dragOverContainerIdRef = useRef(undefined);
  const dragStartRef = useRef({ pointerId: null, entryId: null, startX: 0, startY: 0 });
  const dragPointerRef = useRef({ pointerId: null, x: 0, y: 0 });
  const [dragPointer, setDragPointer] = useState(null);
  const [showReturns, setShowReturns] = useState(() => read(KEYS.FLOW_DIAGRAM_SHOW_RETURNS, { defaultValue: 'true' }) !== 'false');
  const [hoveredNavigationEdgeId, setHoveredNavigationEdgeId] = useState(null);
  const [pinnedNavigationEdgeId, setPinnedNavigationEdgeId] = useState(null);
  const [navigationTooltip, setNavigationTooltip] = useState(null);
  const [focusMode, setFocusMode] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const projectRef = useRef(project);
  const projectIndexRef = useRef(projectIndex);
  const onMoveToMenuRef = useRef(onMoveToMenu);
  const onSelectRef = useRef(onSelect);
  const selectedIdsRef = useRef(selectedIds);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const activeNavigationEdgeIdRef = useRef(null);
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

  const handleShowReturnsChange = useCallback((checked) => {
    setShowReturns(checked);
    write(KEYS.FLOW_DIAGRAM_SHOW_RETURNS, checked ? 'true' : 'false');
  }, []);

  const markViewportMoving = useCallback((kind) => {
    const stage = containerRef.current;
    if (!stage) return;
    stage.classList.add('is-viewport-moving');
    // Le masquage des vignettes ne sert qu'au zoom (re-echantillonnage a chaque
    // echelle) ; au pan (translation) elles restent visibles.
    stage.classList.toggle('is-viewport-zooming', kind === 'zoom');
    if (viewportIdleTimerRef.current != null) {
      window.clearTimeout(viewportIdleTimerRef.current);
    }
    viewportIdleTimerRef.current = window.setTimeout(() => {
      viewportIdleTimerRef.current = null;
      const node = containerRef.current;
      node?.classList.remove('is-viewport-moving');
      node?.classList.remove('is-viewport-zooming');
    }, 140);
  }, []);

  const writeViewportTransform = useCallback(() => {
    viewportFrameRef.current = null;
    const canvas = canvasRef.current;
    const { x, y } = cameraRef.current;
    const currentZoom = zoomRef.current;
    if (canvas) {
      canvas.style.transform = `translate(${x}px, ${y}px) scale(${currentZoom})`;
    }
    if (zoomValueRef.current) {
      zoomValueRef.current.textContent = `${Math.round(currentZoom * 100)}%`;
    }

    if (perfEnabledRef.current) {
      const now = performance.now();
      const perf = viewportPerfRef.current;
      perf.transformFrames += 1;
      if (perf.lastWheelAt) {
        perf.maxWheelDelay = Math.max(perf.maxWheelDelay, now - perf.lastWheelAt);
      }
      if (now - perf.lastLogAt > 1000) {
        logger.warn('diagram:viewport-perf', {
          wheelEvents: perf.wheelEvents,
          transformFrames: perf.transformFrames,
          maxWheelDelayMs: Math.round(perf.maxWheelDelay),
          zoom: Number(currentZoom.toFixed(3)),
          ...layoutStatsRef.current,
        });
        perf.wheelEvents = 0;
        perf.transformFrames = 0;
        perf.maxWheelDelay = 0;
        perf.lastLogAt = now;
      }
    }
  }, []);

  const scheduleViewportTransform = useCallback((immediate = false, moveKind = null) => {
    if (moveKind) markViewportMoving(moveKind);
    if (immediate) {
      if (viewportFrameRef.current != null) {
        cancelAnimationFrame(viewportFrameRef.current);
        viewportFrameRef.current = null;
      }
      writeViewportTransform();
      return;
    }
    if (viewportFrameRef.current == null) {
      viewportFrameRef.current = requestAnimationFrame(writeViewportTransform);
    }
  }, [markViewportMoving, writeViewportTransform]);

  projectRef.current = project;
  projectIndexRef.current = projectIndex;
  onMoveToMenuRef.current = onMoveToMenu;
  onSelectRef.current = onSelect;
  selectedIdsRef.current = selectedIds;
  onSelectionChangeRef.current = onSelectionChange;
  kbHandlersRef.current = {
    handleCopy,
    handleCut,
    handlePaste,
    handleDeleteSelection,
    selectedId: selectedIds?.size ? selectedId : null,
  };

  useEffect(() => {
    function onKeyDown(e) {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key === 'Escape' && activeNavigationEdgeIdRef.current) {
        setHoveredNavigationEdgeId(null);
        setPinnedNavigationEdgeId(null);
        setNavigationTooltip(null);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      const actionId = findShortcutAction(e, getCurrentShortcuts(), 'diagram');
      if (!actionId) return;
      const { handleCopy: copy, handleCut: cut, handlePaste: paste, handleDeleteSelection: del, selectedId: sid } = kbHandlersRef.current;
      e.preventDefault();
      if (actionId === 'diagramCopy') copy(sid);
      else if (actionId === 'diagramCut') cut(sid);
      else if (actionId === 'diagramPaste') paste(sid);
      else if (actionId === 'diagramDelete') void del(sid);
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
    scheduleViewportTransform(false, 'zoom');
  }, [scheduleViewportTransform]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node) return undefined;

    function handleWheel(event) {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const scaleFactor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      if (perfEnabledRef.current) {
        const perf = viewportPerfRef.current;
        perf.wheelEvents += 1;
        perf.lastWheelAt = performance.now();
      }
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
    () => (focusMode ? buildFocusProject(project, selectedId, END_NODE_ID, projectIndex) : project),
    [focusMode, project, projectIndex, selectedId],
  );
  const childSummaryById = useMemo(
    () => buildChildSummaryMap(project.rootEntries ?? []),
    [project.rootEntries],
  );
  const structureActionTargetMenuId = useMemo(() => {
    if (!selectedId || selectedId === 'root' || selectedId === END_NODE_ID) return null;
    const entry = findEntryById(project, selectedId, projectIndex);
    if (entry?.type === 'menu') return selectedId;
    return findParentMenuId(project, selectedId, projectIndex) ?? null;
  }, [project, projectIndex, selectedId]);
  const layout = useMemo(
    () => getCompleteLayout(visibleProject, compactMode, { collapsedIds }),
    [visibleProject, compactMode, collapsedIds],
  );
  const allNavigationEdges = useMemo(() => getCompleteNavigationEdges(visibleProject, layout), [visibleProject, layout]);
  useEffect(() => {
    layoutStatsRef.current = {
      nodes: layout.nodes.length,
      structureEdges: layout.edges.length,
      navigationEdges: allNavigationEdges.length,
      groups: layout.groups?.length ?? 0,
      width: Math.round(layout.width),
      height: Math.round(layout.height),
    };
    if (perfEnabledRef.current) {
      logger.warn('diagram:layout-stats', layoutStatsRef.current);
    }
  }, [allNavigationEdges.length, layout.edges.length, layout.groups?.length, layout.height, layout.nodes.length, layout.width]);
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
  const nodeLabelById = useMemo(() => new Map(layout.nodes.map((node) => [
    node.entry.id,
    node.entry.name || TYPE_LABELS[node.entry.type] || node.entry.id,
  ])), [layout.nodes]);
  const nodeById = useMemo(() => new Map(layout.nodes.map((node) => [node.entry.id, node])), [layout.nodes]);
  const edgeKey = useCallback((edge) => [
    edge.kind,
    edge.source || 'configured',
    edge.from,
    edge.to,
    edge.label || '',
    Math.round(edge.x1),
    Math.round(edge.y1),
  ].join(':'), []);
  const activeNavigationEdgeId = hoveredNavigationEdgeId ?? pinnedNavigationEdgeId;
  const activeNavigationEdge = useMemo(
    () => navigationEdges.find((edge) => edgeKey(edge) === activeNavigationEdgeId) ?? null,
    [activeNavigationEdgeId, edgeKey, navigationEdges],
  );
  const getNavigationEdgeForNode = useCallback((nodeId) => {
    if (!showReturns || !nodeId) return null;
    const priority = { sequence: 0, return: 1, home: 2 };
    const byPriority = (a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9);
    const outgoing = navigationEdges
      .filter((edge) => edge.from === nodeId)
      .sort(byPriority);
    if (outgoing.length > 0) return outgoing[0];
    const incoming = navigationEdges
      .filter((edge) => edge.to === nodeId || edge.endNodeTargetId === nodeId)
      .sort(byPriority);
    return incoming[0] ?? null;
  }, [navigationEdges, showReturns]);
  const handleSelectNode = useCallback((nodeId) => {
    if (showReturns) {
      const edge = getNavigationEdgeForNode(nodeId);
      setPinnedNavigationEdgeId(edge ? edgeKey(edge) : null);
      setHoveredNavigationEdgeId(null);
      setNavigationTooltip(null);
    }
    onSelect?.(nodeId);
  }, [edgeKey, getNavigationEdgeForNode, onSelect, showReturns]);
  const activeNavigationEdgeIds = useMemo(() => {
    if (!activeNavigationEdge) return new Set();
    const ids = new Set([edgeKey(activeNavigationEdge)]);
    if (activeNavigationEdge.to === END_NODE_ID) {
      for (const edge of navigationEdges) {
        if (edge.from === END_NODE_ID && edge.to === activeNavigationEdge.endNodeTargetId) ids.add(edgeKey(edge));
      }
    }
    return ids;
  }, [activeNavigationEdge, edgeKey, navigationEdges]);
  const activeNavigationNodeIds = useMemo(() => {
    if (!activeNavigationEdge) return new Set();
    const ids = new Set([activeNavigationEdge.from, activeNavigationEdge.to]);
    if (activeNavigationEdge.to === END_NODE_ID && activeNavigationEdge.endNodeTargetId) {
      for (const edge of navigationEdges) {
        if (edge.from === END_NODE_ID && edge.to === activeNavigationEdge.endNodeTargetId) {
          ids.add(edge.from);
          ids.add(edge.to);
        }
      }
      ids.add(activeNavigationEdge.endNodeTargetId);
    }
    return ids;
  }, [activeNavigationEdge, navigationEdges]);
  const hasActiveNavigationEdge = !!activeNavigationEdge;
  const activeEndNodeContinuationEdge = useMemo(() => {
    if (!activeNavigationEdge || activeNavigationEdge.to !== END_NODE_ID || !activeNavigationEdge.endNodeTargetId) return null;
    if (navigationEdges.some((edge) => edge.from === END_NODE_ID && edge.to === activeNavigationEdge.endNodeTargetId)) return null;
    const from = nodeById.get(END_NODE_ID);
    const to = nodeById.get(activeNavigationEdge.endNodeTargetId);
    if (!from || !to) return null;
    const x1 = from.x + (from.width / 2);
    const y1 = from.y;
    const x2 = to.x + (to.width / 2);
    const y2 = to.y + to.height;
    const verticalDirection = y2 >= y1 ? 1 : -1;
    const controlOffset = Math.max(80, Math.abs(x2 - x1) * 0.2, Math.abs(y2 - y1) * 0.34);
    return {
      x1,
      y1,
      x2,
      y2,
      c1y: y1 + (controlOffset * verticalDirection),
      c2y: y2 - (controlOffset * verticalDirection),
    };
  }, [activeNavigationEdge, navigationEdges, nodeById]);
  function describeNavigationEdge(edge) {
    const from = nodeLabelById.get(edge.from) ?? edge.from;
    const to = nodeLabelById.get(edge.to) ?? edge.to;
    if (edge.to === END_NODE_ID) {
      const finalTarget = edge.endNodeTargetId ? (nodeLabelById.get(edge.endNodeTargetId) ?? edge.endNodeTargetId) : null;
      return finalTarget
        ? `À la fin de « ${from} » → message de fin → « ${finalTarget} »`
        : `À la fin de « ${from} » → message de fin`;
    }
    const kindLabel = edge.kind === 'home'
      ? 'Retour Home'
      : edge.kind === 'sequence'
        ? 'Séquence de fin'
        : 'Retour';
    if (edge.kind === 'home') return `Bouton Home pendant « ${from} » → « ${to} »`;
    if (edge.kind === 'sequence') return `Séquence de fin de « ${from} » → « ${to} »`;
    return edge.label ? `${edge.label} : ${from} → ${to}` : `${kindLabel} : « ${from} » → « ${to} »`;
  }
  function updateNavigationTooltip(event, edge) {
    const node = containerRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setNavigationTooltip({
      text: `${describeNavigationEdge(edge)}. Clique pour ${pinnedNavigationEdgeId === edgeKey(edge) ? 'désépingler' : 'épingler'} ce trajet.`,
      left: event.clientX - rect.left + 12,
      top: event.clientY - rect.top + 12,
    });
  }
  useEffect(() => {
    didInitialCenterRef.current = false;
  }, [project, focusMode, collapsedIds]);

  useEffect(() => {
    if (!showReturns) {
      setHoveredNavigationEdgeId(null);
      setPinnedNavigationEdgeId(null);
      setNavigationTooltip(null);
    }
  }, [showReturns]);

  useEffect(() => {
    if (pinnedNavigationEdgeId && !navigationEdges.some((edge) => edgeKey(edge) === pinnedNavigationEdgeId)) {
      setPinnedNavigationEdgeId(null);
    }
    if (hoveredNavigationEdgeId && !navigationEdges.some((edge) => edgeKey(edge) === hoveredNavigationEdgeId)) {
      setHoveredNavigationEdgeId(null);
    }
  }, [edgeKey, hoveredNavigationEdgeId, navigationEdges, pinnedNavigationEdgeId]);

  useEffect(() => {
    draggingIdRef.current = draggingId;
  }, [draggingId]);

  useEffect(() => {
    activeNavigationEdgeIdRef.current = activeNavigationEdgeId;
  }, [activeNavigationEdgeId]);

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
    scheduleViewportTransform(true);
    didInitialCenterRef.current = true;
  }, [containerWidth, containerHeight, layout.height, layout.width, scheduleViewportTransform]);

  useEffect(() => () => {
    if (viewportFrameRef.current != null) {
      cancelAnimationFrame(viewportFrameRef.current);
      viewportFrameRef.current = null;
    }
    if (viewportIdleTimerRef.current != null) {
      window.clearTimeout(viewportIdleTimerRef.current);
      viewportIdleTimerRef.current = null;
    }
  }, []);

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
    if (event.target.closest('.fd-complete-node, .fd-complete-zoom, .fd-complete-topbar')) return;
    setHoveredNavigationEdgeId(null);
    setPinnedNavigationEdgeId(null);
    setNavigationTooltip(null);
    if (selectedIdsRef.current?.size) {
      onSelectionChangeRef.current?.(new Set());
    }
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
    scheduleViewportTransform(false, 'pan');
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
    handleSelectNode(entryId);
  }

  const handleContextMenu = useCallback((e, nodeId, nodeType) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIds?.has(nodeId)) {
      onSelectionChange?.(new Set([nodeId]));
      handleSelectNode(nodeId);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, nodeType });
  }, [handleSelectNode, selectedIds, onSelectionChange]);

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
    const targetId = getPasteTargetId(nodeId ?? (selectedIds?.size ? selectedId : null));
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
    void dropOnNode({
      nodeId,
      nodeType,
      path: clip.path,
      paths: clip.paths,
      kind,
      clipboardMode: clip.mode,
    });
    if (clip.mode === 'cut') clipboard.clear();
  }

  async function handleDeleteSelection(nodeId) {
    const onlyEndNodeSelected = selectedIds?.size === 1 && selectedIds?.has(END_NODE_ID);
    if (nodeId === END_NODE_ID && onlyEndNodeSelected) {
      const removed = await onRemoveEndNode?.();
      if (removed === false) return;
      onSelectionChange?.(new Set(['root']));
      handleSelectNode('root');
      return;
    }

    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    onBulkDeleteItems?.(topLevel);
    onSelectionChange?.(new Set(['root']));
    handleSelectNode('root');
  }

  function buildActions(nodeId, nodeType) {
    if (nodeId === END_NODE_ID) {
      return [{ icon: <Trash2 />, label: 'Supprimer le message de fin', fn: () => onRemoveEndNode?.(), danger: true }];
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
      actions.push({ icon: <Moon />, label: 'Ajouter un message de fin', fn: () => onAddEndNode?.() });
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
        <div className="fd-complete-topbar">
          <StructureActionsBar
            targetMenuId={structureActionTargetMenuId}
            onAddStory={onAddStory}
            onAddFolder={onAddMenu}
            onImportFolder={onImportFolder}
            onImportPodcast={onImportPodcast}
            onRecord={onRecord}
            onLaunchSimulator={onSimulateRoot}
            showLabel
          />
          <div className="fd-complete-viewbar" aria-label="Modes du diagramme">
            <label className="fd-complete-toggle">
              <input
                type="checkbox"
                checked={showReturns}
                onChange={(event) => handleShowReturnsChange(event.target.checked)}
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
        </div>
        <div className="fd-complete-zoom">
          <button type="button" className="fd-complete-zoom-btn" onClick={() => handleZoom(BUTTON_ZOOM_FACTOR)}>+</button>
          <div ref={zoomValueRef} className="fd-complete-zoom-value">{Math.round(zoomRef.current * 100)}%</div>
          <button type="button" className="fd-complete-zoom-btn" onClick={() => handleZoom(1 / BUTTON_ZOOM_FACTOR)}>−</button>
        </div>

        <div className="fd-complete-viewport">
          <div
            ref={canvasRef}
            className={`fd-complete-canvas fd-complete-canvas--${compactMode}`}
            style={{
              '--fd-node-width': `${layout.metrics.nodeWidth}px`,
              '--fd-node-root-width': `${layout.metrics.rootWidth}px`,
              width: layout.width,
              height: layout.height,
              transform: `translate(${cameraRef.current.x}px, ${cameraRef.current.y}px) scale(${zoomRef.current})`,
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
              {navigationEdges.map((edge) => {
                const id = edgeKey(edge);
                const isActive = activeNavigationEdgeIds.has(id);
                const isDimmed = hasActiveNavigationEdge && !isActive;
                const d = `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.c1y} ${edge.x2} ${edge.c2y} ${edge.x2} ${edge.y2}`;
                const labelOnly = edge.from === END_NODE_ID && edge.to === END_NODE_ID && edge.source === 'contextual';
                return (
                  <g
                    key={id}
                    className={`fd-complete-navigation-edge ${isActive ? 'is-active' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
                    onPointerEnter={(event) => {
                      setHoveredNavigationEdgeId(id);
                      updateNavigationTooltip(event, edge);
                    }}
                    onPointerMove={(event) => updateNavigationTooltip(event, edge)}
                    onPointerLeave={() => {
                      setHoveredNavigationEdgeId(null);
                      setNavigationTooltip(null);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPinnedNavigationEdgeId((current) => (current === id ? null : id));
                    }}
                  >
                    {labelOnly ? null : (
                      <>
                        <path
                          className="fd-complete-line-hitbox"
                          d={d}
                        />
                        <path
                          className={`fd-complete-line fd-complete-line--${edge.kind} fd-complete-line--${edge.source || 'configured'} ${selectedId === edge.from || selectedId === edge.to ? 'is-related' : ''}`}
                          d={d}
                        />
                      </>
                    )}
                  </g>
                );
              })}
              {activeEndNodeContinuationEdge ? (
                <path
                  className="fd-complete-line fd-complete-line--return fd-complete-line--end-continuation"
                  d={`M ${activeEndNodeContinuationEdge.x1} ${activeEndNodeContinuationEdge.y1} C ${activeEndNodeContinuationEdge.x1} ${activeEndNodeContinuationEdge.c1y} ${activeEndNodeContinuationEdge.x2} ${activeEndNodeContinuationEdge.c2y} ${activeEndNodeContinuationEdge.x2} ${activeEndNodeContinuationEdge.y2}`}
                />
              ) : null}
              {navigationEdges.filter((edge) => edge.label).map((edge) => (
                <text
                  key={`label-${edgeKey(edge)}`}
                  className={`fd-complete-edge-label fd-complete-edge-label--${edge.kind} ${activeNavigationEdgeIds.has(edgeKey(edge)) ? 'is-active' : hasActiveNavigationEdge ? 'is-dimmed' : ''}`}
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
                className={`fd-complete-placed-node ${activeNavigationNodeIds.has(node.entry.id) ? 'is-navigation-active' : hasActiveNavigationEdge ? 'is-navigation-dimmed' : ''}`}
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
                  onSelect={handleSelectNode}
                  onSelectionChange={onSelectionChange}
                  onContextMenu={handleContextMenu}
                  onPreview={onPreview}
                  onInspect={onInspect}
                  onDragPointerDown={handleDragPointerDown}
                  onToggleCollapse={toggleCollapse}
                  viewportRootRef={containerRef}
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
        {navigationTooltip ? (
          <div
            className="fd-navigation-tooltip"
            style={{ left: navigationTooltip.left, top: navigationTooltip.top }}
          >
            {navigationTooltip.text}
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
