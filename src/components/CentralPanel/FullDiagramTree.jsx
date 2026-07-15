import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findParentMenuId, findEntryById } from '../../store/projectModel';
import { KEYS, read, write } from '../../store/persistentSettings';
import { useProjectActions } from '../../store/ProjectActionsContext';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import { isModalSurfaceOpen } from '../../utils/modalSurfaces';
import { ContextMenu } from '../TreePanel/ContextMenu';
import {
  BUTTON_ZOOM_FACTOR,
  getCompleteMetrics,
  getCompleteNavigationEdges,
  END_NODE_ID,
  TYPE_LABELS,
} from './flowDiagramLayout';
import {
  buildChildSummaryMap,
  buildFocusProject,
} from './fullDiagramFocus.js';
import { FullDiagramNode } from './FullDiagramNode.jsx';
import { StructureActionsBar } from '../structure/StructureActionsBar.jsx';
import { useDiagramViewport } from './diagram/useDiagramViewport';
import { getDiagramViewportLayoutKey } from './diagram/viewportGeometry.js';
import { useDiagramNodeDrag } from './diagram/useDiagramNodeDrag';
import { useDiagramClipboard } from './diagram/useDiagramClipboard';
import { buildDiagramContextActions } from './diagram/diagramContextMenu';
import { DiagramZoomControls } from './diagram/DiagramZoomControls';
import { DiagramLegend } from './diagram/DiagramLegend';
import { DiagramViewToggles } from './diagram/DiagramViewToggles';
import { DiagramSearch } from './diagram/DiagramSearch';
import {
  buildNavigationNodeRoles,
  collectActiveNavigationPathEdges,
  navigationEdgeTouchesNode,
} from './diagram/navigationPresentation';
import { presentLocalEndSteps } from './diagram/localEndStepPresentation';
import {
  buildStructureFocus,
  getFolderCollapseIntent,
  getStoryGroupId,
  getStructureEdgeId,
  toggleExclusiveStoryGroup,
} from './diagram/structurePresentation';
import { getStructureLevelLayout } from './diagram/structureLevelLayout';
import { StructureFocusBar } from './diagram/StructureFocusBar';
import { StructureLevelSummaryNode } from './diagram/StructureLevelSummaryNode';
import { StructureDiagramLayer } from './diagram/StructureDiagramLayer';
import { IconMoon, IconStop } from '../TreePanel/TreeIcons';

export function CompleteDiagramTree({
  project,
  projectIndex,
  selectedId,
  selectedIds,
  onSelectNode,
  onSelectionChange,
  selectionRevealRequest = null,
  searchFocusTrigger = 0,
  expandedStoryGroupId = null,
  onExpandedStoryGroupIdChange,
  onPreview,
  onSimulateZip,
  onSimulateRoot,
  onOpenLocalEndSettings,
  controlsHost = null,
  showActionsBar = false,
  showHint = false,
}) {
  const {
    onSelect: defaultOnSelect,
    onMoveToMenu,
    onImportFolder,
    onImportPodcast,
    onImportYoutube,
    onRecord,
    onGenerateStoryTts,
    canGenerateStoryTts,
    onAddMenu,
    onAddStoryToMenu,
    onUnpackZip,
    onSetMenuAsRoot,
    onDeleteMenu,
    onDeleteItem,
    onBulkDeleteItems,
    onBulkUpdateItems,
    onUpdateMedia,
    onUpdateMenu,
    onUpdateItem,
    onPasteEntries,
    onCutPasteEntries,
    onDuplicate,
    onAddEndNode,
    onRemoveEndNode,
  } = useProjectActions();
  const [showReturns, setShowReturns] = useState(() => read(KEYS.FLOW_DIAGRAM_SHOW_RETURNS, { defaultValue: 'true' }) !== 'false');
  const [hoveredNavigationEdgeId, setHoveredNavigationEdgeId] = useState(null);
  const [pinnedNavigationEdgeId, setPinnedNavigationEdgeId] = useState(null);
  const [navigationTooltip, setNavigationTooltip] = useState(null);
  const [focusMode, setFocusMode] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState(() => new Set());
  const [hoveredStructureEdgeId, setHoveredStructureEdgeId] = useState(null);
  const [pinnedStructureEdgeId, setPinnedStructureEdgeId] = useState(null);
  const [pendingRevealNodeId, setPendingRevealNodeId] = useState(null);
  const activeNavigationEdgeIdRef = useRef(null);
  const activeStructureEdgeIdRef = useRef(null);
  const kbHandlersRef = useRef(null);
  const selectNode = onSelectNode ?? defaultOnSelect;

  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, nodeId, nodeType }

  useEffect(() => {
    if (!selectedId && focusMode) setFocusMode(false);
  }, [focusMode, selectedId]);

  const toggleCollapse = useCallback((entryId) => {
    const intent = getFolderCollapseIntent({
      entryId,
      expandedStoryGroupId,
      isCollapsed: collapsedIds.has(entryId),
    });
    if (intent.regroupStories) onExpandedStoryGroupIdChange?.(null);
    if (!intent.toggleFolder) return;

    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, [collapsedIds, expandedStoryGroupId, onExpandedStoryGroupIdChange]);

  const handleShowReturnsChange = useCallback((checked) => {
    setShowReturns(checked);
    write(KEYS.FLOW_DIAGRAM_SHOW_RETURNS, checked ? 'true' : 'false');
  }, []);
  const handleToggleStoryGroup = useCallback((groupId) => {
    onExpandedStoryGroupIdChange?.(toggleExclusiveStoryGroup(expandedStoryGroupId, groupId));
  }, [expandedStoryGroupId, onExpandedStoryGroupIdChange]);

  // Le pan du fond sert a naviguer dans le canvas, pas a changer le modele de
  // selection : on conserve la selection globale (l'arbre controle refleterait
  // sinon un etat vide incoherent avec `selectedId`). On ne nettoie que le survol
  // d'aretes de navigation.
  const handleStagePanStart = useCallback(() => {
    setHoveredNavigationEdgeId(null);
    setPinnedNavigationEdgeId(null);
    setNavigationTooltip(null);
    setHoveredStructureEdgeId(null);
  }, []);

  const {
    containerRef,
    canvasRef,
    zoomValueRef,
    zoomRef,
    cameraRef,
    compactMode,
    isPanning,
    handleZoom,
    updateLayoutStats,
    fitViewportToLayout,
    centerViewportOnNode,
    stagePointerHandlers,
  } = useDiagramViewport({ onStagePanStart: handleStagePanStart });
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
  const layout = useMemo(() => getStructureLevelLayout(visibleProject, getCompleteMetrics(compactMode), {
    collapsedIds,
    expandedStoryGroupIds: expandedStoryGroupId ? new Set([expandedStoryGroupId]) : new Set(),
  }), [visibleProject, compactMode, collapsedIds, expandedStoryGroupId]);
  const viewportLayoutKey = useMemo(() => getDiagramViewportLayoutKey(layout, {
    compactMode,
    focusMode,
    selectedId,
    collapsedIds,
    expandedStoryGroupId,
  }), [collapsedIds, compactMode, expandedStoryGroupId, focusMode, layout, selectedId]);
  const structureEdgePaths = useMemo(() => layout.edges.map((edge) => ({
    ...edge,
    id: getStructureEdgeId(edge),
    d: `M ${edge.x1} ${edge.y1} L ${edge.x1} ${edge.midY} L ${edge.x2} ${edge.midY} L ${edge.x2} ${edge.y2}`,
  })), [layout.edges]);
  const rawNavigationEdges = useMemo(
    () => getCompleteNavigationEdges(visibleProject, layout),
    [visibleProject, layout],
  );
  const navigationPresentation = useMemo(
    () => presentLocalEndSteps(layout, rawNavigationEdges),
    [layout, rawNavigationEdges],
  );
  const allNavigationEdges = navigationPresentation.navigationEdges;
  const localEndNodes = navigationPresentation.localNodes;
  useEffect(() => {
    updateLayoutStats(layout, allNavigationEdges.length);
  }, [allNavigationEdges.length, layout, updateLayoutStats]);
  const navigationEdges = useMemo(() => {
    if (!showReturns) return [];
    return allNavigationEdges;
  }, [allNavigationEdges, showReturns]);
  const returnEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'return'), [navigationEdges]);
  const homeEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'home'), [navigationEdges]);
  const afterEndEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'after-end'), [navigationEdges]);
  const referenceEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'reference'), [navigationEdges]);
  const nodeLabelById = useMemo(() => new Map([
    ...(projectIndex?.entryById ? [...projectIndex.entryById].map(([id, entry]) => [
      id,
      entry.name || TYPE_LABELS[entry.type] || id,
    ]) : []),
    ...layout.nodes.map((node) => [
      node.entry.id,
      node.entry.name || TYPE_LABELS[node.entry.type] || node.entry.id,
    ]),
    ...localEndNodes.map((node) => [node.id, node.label]),
    ...(layout.groups ?? []).map((group) => [group.id, `${group.storyCount} histoires`]),
  ]), [layout.groups, layout.nodes, localEndNodes, projectIndex]);
  const nodeById = useMemo(() => new Map([
    ...layout.nodes.map((node) => [node.entry.id, node]),
    ...localEndNodes.map((node) => [node.id, node]),
  ]), [layout.nodes, localEndNodes]);
  const queueRevealNode = useCallback((nodeId) => {
    if (!nodeId) return;
    setPendingRevealNodeId(nodeId);
    if (nodeId === 'root' || nodeId === END_NODE_ID) return;
    setCollapsedIds((current) => {
      const next = new Set(current);
      let changed = false;
      let parentId = projectIndex.parentMenuById.get(nodeId) ?? null;
      while (parentId != null) {
        changed = next.delete(parentId) || changed;
        parentId = projectIndex.parentMenuById.get(parentId) ?? null;
      }
      return changed ? next : current;
    });
  }, [projectIndex]);
  const lastSelectionRevealRequestRef = useRef(null);
  useEffect(() => {
    const requestId = selectionRevealRequest?.requestId;
    if (!requestId || lastSelectionRevealRequestRef.current === requestId) return;
    lastSelectionRevealRequestRef.current = requestId;
    queueRevealNode(selectionRevealRequest.id);
  }, [queueRevealNode, selectionRevealRequest]);
  const activeStructureEdgeId = hoveredStructureEdgeId ?? pinnedStructureEdgeId;
  const structureFocus = useMemo(
    () => buildStructureFocus(layout.edges, activeStructureEdgeId, nodeLabelById),
    [activeStructureEdgeId, layout.edges, nodeLabelById],
  );
  const activeStructureNodeIds = useMemo(() => {
    if (!structureFocus) return new Set();
    const ids = new Set(structureFocus.pathNodeIds);
    const activeGroup = (layout.groups ?? []).find((group) => group.id === structureFocus.activeEdge.to);
    activeGroup?.storyIds?.forEach((storyId) => ids.add(storyId));
    return ids;
  }, [layout.groups, structureFocus]);
  const hasActiveStructureEdge = !!structureFocus;
  const handleStructurePointerEnter = useCallback((edgeId) => {
    setHoveredStructureEdgeId(edgeId);
    setHoveredNavigationEdgeId(null);
    setPinnedNavigationEdgeId(null);
    setNavigationTooltip(null);
  }, []);
  const handleStructurePointerLeave = useCallback(() => {
    setHoveredStructureEdgeId(null);
  }, []);
  const handleStructureClick = useCallback((event, edgeId) => {
    event.stopPropagation();
    setPinnedStructureEdgeId((current) => (current === edgeId ? null : edgeId));
    setHoveredStructureEdgeId(null);
    setPinnedNavigationEdgeId(null);
    setHoveredNavigationEdgeId(null);
    setNavigationTooltip(null);
  }, []);
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
    const priority = { 'after-end': 0, sequence: 0, return: 1, reference: 1, home: 2 };
    const byPriority = (a, b) => (priority[a.kind] ?? 9) - (priority[b.kind] ?? 9);
    const outgoing = navigationEdges
      .filter((edge) => navigationEdgeTouchesNode(edge, nodeId))
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
    selectNode?.(nodeId);
  }, [edgeKey, getNavigationEdgeForNode, selectNode, showReturns]);
  const handleSearchChoose = useCallback((nodeId) => {
    onSelectionChange?.(new Set([nodeId]));
    queueRevealNode(nodeId);
    handleSelectNode(nodeId);
  }, [handleSelectNode, onSelectionChange, queueRevealNode]);
  const handleOpenLocalEnd = useCallback((storyId) => {
    onSelectionChange?.(new Set([storyId]));
    if (onOpenLocalEndSettings) {
      onOpenLocalEndSettings(storyId);
      return;
    }
    handleSelectNode(storyId);
  }, [handleSelectNode, onOpenLocalEndSettings, onSelectionChange]);
  const activeNavigationPathEdges = useMemo(
    () => collectActiveNavigationPathEdges(activeNavigationEdge, navigationEdges, END_NODE_ID),
    [activeNavigationEdge, navigationEdges],
  );
  const activeNavigationEdgeIds = useMemo(
    () => new Set(activeNavigationPathEdges.map(edgeKey)),
    [activeNavigationPathEdges, edgeKey],
  );
  const activeNavigationNodeRoles = useMemo(
    () => buildNavigationNodeRoles(activeNavigationEdge, navigationEdges, END_NODE_ID),
    [activeNavigationEdge, navigationEdges],
  );
  const activeNavigationNodeIds = activeNavigationNodeRoles.activeNodeIds;
  const activeNavigationMemberNodeIds = activeNavigationNodeRoles.memberNodeIds;
  const hasActiveNavigationEdge = !!activeNavigationEdge;
  const activeEndNodeContinuationEdge = useMemo(() => {
    if (!activeNavigationEdge || activeNavigationEdge.to !== END_NODE_ID || !activeNavigationEdge.endNodeTargetId) return null;
    if (navigationEdges.some((edge) => edge.from === END_NODE_ID && edge.to === activeNavigationEdge.endNodeTargetId)) return null;
    const from = nodeById.get(END_NODE_ID);
    const displayTargetId = layout.hiddenStoryGroupByStoryId?.get(activeNavigationEdge.endNodeTargetId)
      ?? activeNavigationEdge.endNodeTargetId;
    const to = nodeById.get(displayTargetId);
    if (!from || !to) return null;
    const x1 = from.x + (from.width / 2);
    const x2 = to.x + (to.width / 2);
    const nodeVisualHeight = layout.metrics?.nodeVisualHeight ?? layout.metrics?.nodeHeight;
    const visualBottom = (node) => node.y + Math.min(node.height, nodeVisualHeight ?? node.height);
    const targetIsBelow = to.y > from.y;
    const y1 = targetIsBelow ? visualBottom(from) : from.y;
    const y2 = targetIsBelow ? to.y : visualBottom(to);
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
  }, [activeNavigationEdge, layout.hiddenStoryGroupByStoryId, navigationEdges, nodeById]);
  function describeNavigationEdge(edge) {
    const pathEdges = collectActiveNavigationPathEdges(edge, navigationEdges, END_NODE_ID);
    if (edge.localEndStoryId) {
      const exitEdge = pathEdges.find((pathEdge) => pathEdge.localEndLeg === 'exit');
      const localNodeId = pathEdges.find((pathEdge) => pathEdge.localEndLeg === 'start')?.to
        ?? exitEdge?.from;
      const source = nodeLabelById.get(edge.localEndStoryId) ?? edge.localEndStoryId;
      const localStep = nodeLabelById.get(localNodeId) ?? 'message ou scénario de fin';
      const targetId = exitEdge?.displayTo ?? exitEdge?.to;
      const target = nodeLabelById.get(targetId) ?? targetId;
      return `À la fin de « ${source} » → « ${localStep} » → « ${target} »`;
    }
    const incomingEndEdge = pathEdges.find((pathEdge) => pathEdge.to === END_NODE_ID);
    if (edge.from === END_NODE_ID && incomingEndEdge) {
      const source = nodeLabelById.get(incomingEndEdge.from) ?? incomingEndEdge.from;
      const targetId = edge.displayTo ?? edge.to;
      const target = nodeLabelById.get(targetId) ?? targetId;
      if (incomingEndEdge.source === 'global-group') {
        return `${incomingEndEdge.chainStoryIds?.length ?? 0} histoires → message de fin global → « ${target} »`;
      }
      return `À la fin de « ${source} » → message de fin → « ${target} »`;
    }
    const from = nodeLabelById.get(edge.from) ?? edge.from;
    const targetId = edge.displayTo ?? edge.to;
    const to = nodeLabelById.get(targetId) ?? targetId;
    if (edge.to === END_NODE_ID) {
      const finalTarget = edge.endNodeTargetId ? (nodeLabelById.get(edge.endNodeTargetId) ?? edge.endNodeTargetId) : null;
      if (edge.source === 'global-group') {
        return `${edge.chainStoryIds?.length ?? 0} histoires → message de fin global${finalTarget ? ` → « ${finalTarget} »` : ''}`;
      }
      return finalTarget
        ? `À la fin de « ${from} » → message de fin → « ${finalTarget} »`
        : `À la fin de « ${from} » → message de fin`;
    }
    if (edge.from === END_NODE_ID && edge.source === 'global-context-group') {
      return `Après le message de fin global → reprise contextuelle dans « ${to} » (${edge.chainStoryIds?.length ?? 0} histoires)`;
    }
    const kindLabel = edge.kind === 'home'
      ? 'Retour Home'
      : edge.kind === 'after-end' || edge.kind === 'sequence'
        ? 'Séquence de fin'
        : edge.kind === 'reference'
          ? 'Lien'
          : 'Retour';
    if (edge.kind === 'home') return `Bouton Home pendant « ${from} » → « ${to} »`;
    if (edge.kind === 'after-end' || edge.kind === 'sequence') {
      const prefix = edge.source === 'prompt-chain'
        ? `Parcours de ${edge.chainStoryIds?.length ?? 0} histoires, après le message de fin`
        : edge.to === END_NODE_ID ? 'Après la lecture → message de fin' : 'Après la séquence ou le message de fin';
      return `${prefix} : « ${from} » → « ${to} »`;
    }
    if (edge.kind === 'reference') return `Lien vers un nœud existant : « ${from} » → « ${to} »`;
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
  useLayoutEffect(() => {
    fitViewportToLayout(layout, viewportLayoutKey);
  }, [fitViewportToLayout, layout, viewportLayoutKey]);

  useLayoutEffect(() => {
    if (!pendingRevealNodeId) return;
    const hiddenGroupId = layout.hiddenStoryGroupByStoryId?.get(pendingRevealNodeId) ?? null;
    if (hiddenGroupId && expandedStoryGroupId !== hiddenGroupId) {
      onExpandedStoryGroupIdChange?.(hiddenGroupId);
      return;
    }
    const targetNode = nodeById.get(pendingRevealNodeId);
    if (targetNode && centerViewportOnNode(targetNode)) {
      setPendingRevealNodeId(null);
    }
  }, [
    centerViewportOnNode,
    expandedStoryGroupId,
    layout.hiddenStoryGroupByStoryId,
    nodeById,
    onExpandedStoryGroupIdChange,
    pendingRevealNodeId,
  ]);

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
    const edgeIds = new Set(layout.edges.map(getStructureEdgeId));
    if (pinnedStructureEdgeId && !edgeIds.has(pinnedStructureEdgeId)) setPinnedStructureEdgeId(null);
    if (hoveredStructureEdgeId && !edgeIds.has(hoveredStructureEdgeId)) setHoveredStructureEdgeId(null);
  }, [hoveredStructureEdgeId, layout.edges, pinnedStructureEdgeId]);

  useEffect(() => {
    activeNavigationEdgeIdRef.current = activeNavigationEdgeId;
  }, [activeNavigationEdgeId]);

  useEffect(() => {
    activeStructureEdgeIdRef.current = activeStructureEdgeId;
  }, [activeStructureEdgeId]);

  const {
    draggingId,
    dragOverContainerId,
    dragPointer,
    handleDragPointerDown,
  } = useDiagramNodeDrag({
    project,
    projectIndex,
    selectedIds,
    onMoveToMenu,
    onSelect: selectNode,
    onSelectionChange,
    onDragSelect: handleSelectNode,
  });

  const {
    clipboardRef,
    cutIds,
    getTopLevelSelected,
    handleCopy,
    handleCut,
    handlePaste,
    handlePasteMedia,
    handleDeleteSelection,
  } = useDiagramClipboard({
    project,
    projectIndex,
    selectedId,
    selectedIds,
    onSelectionChange,
    onPasteEntries,
    onCutPasteEntries,
    onBulkDeleteItems,
    onRemoveEndNode,
    onSelectNode: handleSelectNode,
  });

  kbHandlersRef.current = {
    handleCopy,
    handleCut,
    handlePaste,
    handleDeleteSelection,
    selectedId: selectedIds?.size ? selectedId : null,
  };

  useEffect(() => {
    function onKeyDown(e) {
      // Même garde que useAppShortcuts : couper/coller/supprimer un nœud du
      // diagramme ne doit pas agir derrière une modale ouverte.
      if (isModalSurfaceOpen()) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key === 'Escape' && (activeNavigationEdgeIdRef.current || activeStructureEdgeIdRef.current)) {
        setHoveredNavigationEdgeId(null);
        setPinnedNavigationEdgeId(null);
        setNavigationTooltip(null);
        setHoveredStructureEdgeId(null);
        setPinnedStructureEdgeId(null);
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

  const handleContextMenu = useCallback((e, nodeId, nodeType) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedIds?.has(nodeId)) {
      onSelectionChange?.(new Set([nodeId]));
      handleSelectNode(nodeId);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, nodeType });
  }, [handleSelectNode, selectedIds, onSelectionChange]);

  function buildActions(nodeId, nodeType) {
    return buildDiagramContextActions({
      project,
      projectIndex,
      selectedIds,
      nodeId,
      nodeType,
      clipboardRef,
      onMoveToMenu,
      onAddMenu,
      onAddStory: onAddStoryToMenu,
      onUnpackZip,
      onSimulateZip,
      onSetMenuAsRoot,
      onDeleteMenu,
      onDeleteItem,
      onBulkUpdateItems,
      onUpdateMedia,
      onUpdateMenu,
      onUpdateItem,
      onDuplicate,
      onAddEndNode,
      onRemoveEndNode,
      getTopLevelSelected,
      handleCopy,
      handleCut,
      handlePaste,
      handlePasteMedia,
      handleDeleteSelection,
      closeContextMenu: () => setCtxMenu(null),
    });
  }

  const viewControls = (
    <DiagramViewToggles
      showReturns={showReturns}
      onShowReturnsChange={handleShowReturnsChange}
      focusMode={focusMode}
      onFocusModeToggle={() => setFocusMode((current) => !current)}
      canFocusBranch={!!selectedId}
      hasCollapsedNodes={collapsedIds.size > 0}
      onOpenAll={() => setCollapsedIds(new Set())}
      hasExpandedStoryGroups={!!expandedStoryGroupId}
      onRegroupStories={() => onExpandedStoryGroupIdChange?.(null)}
    />
  );

  return (
    <div className="fd-complete-shell">
      {controlsHost ? createPortal(viewControls, controlsHost) : null}
      <div
        ref={containerRef}
        className={`fd-complete-stage ${isPanning ? 'is-panning' : ''}`}
        tabIndex={0}
        {...stagePointerHandlers}
      >
        <DiagramSearch
          project={project}
          projectIndex={projectIndex}
          focusTrigger={searchFocusTrigger}
          onChoose={handleSearchChoose}
        />
        {showActionsBar ? (
        <div className="fd-complete-topbar">
          <StructureActionsBar
            variant="floating"
            targetMenuId={structureActionTargetMenuId}
            onAddStory={onAddStoryToMenu}
            onAddFolder={onAddMenu}
            onImportFolder={onImportFolder}
            onImportPodcast={onImportPodcast}
            onImportYoutube={onImportYoutube}
            onRecord={onRecord}
            onGenerateStoryTts={onGenerateStoryTts}
            canGenerateStoryTts={canGenerateStoryTts}
            onLaunchSimulator={onSimulateRoot}
            showLabel
          />
        </div>
        ) : null}
        <DiagramZoomControls
          zoomValueRef={zoomValueRef}
          zoom={zoomRef.current}
          onZoomIn={() => handleZoom(BUTTON_ZOOM_FACTOR)}
          onZoomOut={() => handleZoom(1 / BUTTON_ZOOM_FACTOR)}
        />
        <StructureFocusBar
          focus={structureFocus}
          pinned={!!pinnedStructureEdgeId}
          onClear={() => {
            setHoveredStructureEdgeId(null);
            setPinnedStructureEdgeId(null);
          }}
        />

        <div className="fd-complete-viewport">
          <div
            ref={canvasRef}
            className={`fd-complete-canvas fd-complete-canvas--${compactMode} is-level-mode ${hasActiveStructureEdge ? 'is-structure-focused' : ''}`}
            style={{
              '--fd-node-width': `${layout.metrics.nodeWidth}px`,
              '--fd-node-root-width': `${layout.metrics.rootWidth}px`,
              width: layout.width,
              height: layout.height,
              transform: `translate(${cameraRef.current.x}px, ${cameraRef.current.y}px) scale(${zoomRef.current})`,
            }}
          >
            <svg className="fd-complete-lines" width={layout.width} height={layout.height} aria-hidden="true">
              <StructureDiagramLayer
                layout={layout}
                structureEdgePaths={structureEdgePaths}
                structureFocus={structureFocus}
                hasActiveStructureEdge={hasActiveStructureEdge}
                onEdgeEnter={handleStructurePointerEnter}
                onEdgeLeave={handleStructurePointerLeave}
                onEdgeClick={handleStructureClick}
              />
              {navigationEdges.map((edge) => {
                const id = edgeKey(edge);
                const isActive = activeNavigationEdgeIds.has(id);
                const isDimmed = hasActiveNavigationEdge && !isActive;
                const d = edge.route === 'same-row-return'
                  ? `M ${edge.x1} ${edge.y1} L ${edge.x1} ${edge.railY} L ${edge.x2} ${edge.railY} L ${edge.x2} ${edge.y2}`
                  : `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.c1y} ${edge.x2} ${edge.c2y} ${edge.x2} ${edge.y2}`;
                const labelOnly = edge.from === END_NODE_ID && edge.to === END_NODE_ID && edge.source === 'contextual';
                return (
                  <g
                    key={id}
                    className={`fd-complete-navigation-edge ${isActive ? 'is-active' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
                    onPointerEnter={(event) => {
                      setHoveredStructureEdgeId(null);
                      setPinnedStructureEdgeId(null);
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
                      setHoveredStructureEdgeId(null);
                      setPinnedStructureEdgeId(null);
                      setPinnedNavigationEdgeId((current) => (current === id ? null : id));
                    }}
                  >
                    {labelOnly ? null : (
                      <>
                        <path
                          className="fd-complete-line-hitbox"
                          d={d}
                        />
                        {edge.kind === 'return' ? (
                          <path
                            className="fd-complete-line-underlay fd-complete-line-underlay--return"
                            d={d}
                          />
                        ) : null}
                        <path
                          className={`fd-complete-line fd-complete-line--${edge.kind} fd-complete-line--${edge.source || 'configured'} ${navigationEdgeTouchesNode(edge, selectedId) ? 'is-related' : ''}`}
                          d={d}
                        />
                      </>
                    )}
                  </g>
                );
              })}
              {activeEndNodeContinuationEdge ? (
                <path
                  className="fd-complete-line fd-complete-line--after-end fd-complete-line--end-continuation"
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

            {/* Le chemin structurel actif repasse au-dessus des parcours. */}
            <svg className={`fd-complete-structure-overlay ${hasActiveStructureEdge ? 'is-visible' : ''}`} width={layout.width} height={layout.height} aria-hidden="true">
              {structureFocus?.pathEdges.map((pathEdge) => structureEdgePaths.find((edge) => edge.id === getStructureEdgeId(pathEdge))).filter(Boolean).map((edge) => (
                <path
                  key={`overlay-${edge.id}`}
                  className={`fd-complete-line fd-complete-line--${edge.kind || 'structural'} ${edge.id === structureFocus.activeEdgeId ? 'is-structure-active' : 'is-structure-path'}`}
                  d={edge.d}
                />
              ))}
            </svg>

            {layout.nodes.map((node) => {
              const isNavigationActive = activeNavigationNodeIds.has(node.entry.id);
              const isNavigationMember = activeNavigationMemberNodeIds.has(node.entry.id);
              return (
                <div
                  key={node.entry.id}
                  className={`fd-complete-placed-node ${isNavigationActive ? 'is-navigation-active' : isNavigationMember ? 'is-navigation-member' : hasActiveNavigationEdge ? 'is-navigation-dimmed' : ''} ${activeStructureNodeIds.has(node.entry.id) ? 'is-structure-active' : structureFocus?.siblingNodeIds.has(node.entry.id) ? 'is-structure-sibling' : hasActiveStructureEdge ? 'is-structure-dimmed' : ''}`}
                  style={{ left: node.x, top: node.y, width: node.width }}
                >
                {node.entry.type === 'story-group' ? (
                  <StructureLevelSummaryNode
                    entry={node.entry}
                    onExpand={handleToggleStoryGroup}
                  />
                ) : (
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
                  onDragPointerDown={handleDragPointerDown}
                  onToggleCollapse={toggleCollapse}
                  viewportRootRef={containerRef}
                  isRoot={node.entry.id === 'root'}
                  rootImage={project.rootImage}
                  isCollapsed={collapsedIds.has(node.entry.id)}
                  hasExpandedStoryGroup={expandedStoryGroupId === getStoryGroupId(node.entry.id)}
                  childSummary={childSummaryById.get(node.entry.id) ?? null}
                />
                )}
                </div>
              );
            })}
            {localEndNodes.map((node) => (
              <button
                key={node.id}
                type="button"
                className={`fd-local-end-node fd-local-end-node--${node.kind} ${activeNavigationNodeIds.has(node.id) ? 'is-navigation-active' : hasActiveNavigationEdge ? 'is-navigation-dimmed' : ''}`}
                style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  handleOpenLocalEnd(node.storyId);
                }}
                title={`Ouvrir les réglages : ${node.label}`}
              >
                <span className="fd-local-end-node-icon">
                  {node.kind === 'sequence' ? <IconStop /> : <IconMoon />}
                </span>
                <span className="fd-local-end-node-text">{node.label}</span>
              </button>
            ))}
          </div>
        </div>
        <DiagramLegend
          returnEdges={returnEdges}
          homeEdges={homeEdges}
          afterEndEdges={afterEndEdges}
          referenceEdges={referenceEdges}
        />
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
        {showHint ? (
          <div className="fd-diagram-hint">
            Clique un nœud pour ouvrir ses réglages à gauche
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
