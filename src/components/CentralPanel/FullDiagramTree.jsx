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
  getCompleteLayout,
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
import { useDiagramNodeDrag } from './diagram/useDiagramNodeDrag';
import { useDiagramClipboard } from './diagram/useDiagramClipboard';
import { buildDiagramContextActions } from './diagram/diagramContextMenu';
import { DiagramZoomControls } from './diagram/DiagramZoomControls';
import { DiagramLegend } from './diagram/DiagramLegend';
import { DiagramViewToggles } from './diagram/DiagramViewToggles';

export function CompleteDiagramTree({
  project,
  projectIndex,
  selectedId,
  selectedIds,
  onSelectionChange,
  onPreview,
  onSimulateZip,
  onSimulateRoot,
  controlsHost = null,
  showActionsBar = false,
  showHint = false,
}) {
  const {
    onSelect,
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
  const selectedIdsRef = useRef(selectedIds);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const activeNavigationEdgeIdRef = useRef(null);
  const kbHandlersRef = useRef(null);

  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, nodeId, nodeType }

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

  const handleStagePanStart = useCallback(() => {
    setHoveredNavigationEdgeId(null);
    setPinnedNavigationEdgeId(null);
    setNavigationTooltip(null);
    if (selectedIdsRef.current?.size) {
      onSelectionChangeRef.current?.(new Set());
    }
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
    resetInitialCenter,
    updateLayoutStats,
    centerInitialViewport,
    stagePointerHandlers,
  } = useDiagramViewport({ onStagePanStart: handleStagePanStart });

  selectedIdsRef.current = selectedIds;
  onSelectionChangeRef.current = onSelectionChange;
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
    updateLayoutStats(layout, allNavigationEdges.length);
  }, [allNavigationEdges.length, layout, updateLayoutStats]);
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
  const referenceEdges = useMemo(() => navigationEdges.filter((edge) => edge.kind === 'reference'), [navigationEdges]);
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
    const priority = { sequence: 0, return: 1, reference: 1, home: 2 };
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
        : edge.kind === 'reference'
          ? 'Lien'
          : 'Retour';
    if (edge.kind === 'home') return `Bouton Home pendant « ${from} » → « ${to} »`;
    if (edge.kind === 'sequence') return `Séquence de fin de « ${from} » → « ${to} »`;
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
  useEffect(() => {
    resetInitialCenter();
  }, [project, focusMode, collapsedIds, resetInitialCenter]);

  useLayoutEffect(() => {
    centerInitialViewport(layout);
  }, [centerInitialViewport, layout]);

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
    activeNavigationEdgeIdRef.current = activeNavigationEdgeId;
  }, [activeNavigationEdgeId]);

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
    onSelect,
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
      hasCollapsedNodes={collapsedIds.size > 0}
      onOpenAll={() => setCollapsedIds(new Set())}
    />
  );

  return (
    <div className="fd-complete-shell">
      {controlsHost ? createPortal(viewControls, controlsHost) : null}
      <div
        ref={containerRef}
        className={`fd-complete-stage ${isPanning ? 'is-panning' : ''}`}
        {...stagePointerHandlers}
      >
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
                const d = edge.route === 'same-row-return'
                  ? `M ${edge.x1} ${edge.y1} L ${edge.x1} ${edge.railY} L ${edge.x2} ${edge.railY} L ${edge.x2} ${edge.y2}`
                  : `M ${edge.x1} ${edge.y1} C ${edge.x1} ${edge.c1y} ${edge.x2} ${edge.c2y} ${edge.x2} ${edge.y2}`;
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
                        {edge.kind === 'return' ? (
                          <path
                            className="fd-complete-line-underlay fd-complete-line-underlay--return"
                            d={d}
                          />
                        ) : null}
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
        <DiagramLegend
          returnEdges={returnEdges}
          homeEdges={homeEdges}
          sequenceEdges={sequenceEdges}
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
