import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Fragment, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { TreeNode } from './TreeNode';
import { TreeSearchBar } from './TreeSearchBar';
import { TreeDragOverlay } from './TreeDragOverlay';
import { ContextMenu } from './ContextMenu';
import { useTreeDnd } from './useTreeDnd';
import { useTreeSelection } from './useTreeSelection';
import { useTreeClipboard } from './useTreeClipboard';
import { useTreeNavigationBadges } from './useTreeNavigationBadges';
import { useTreeSearch } from './useTreeSearch';
import { buildTreeContextActions } from './treeContextMenuActions';
import {
  buildGuideScopeIdsById,
  getNextHoverGuide,
  isEntryInHoverGuide,
  sameHoverGuide,
} from './treeGuides';
import { END_NODE_ID, EMPTY_BADGES } from './treePanelConstants';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import {
  countDescendants,
  resolveDropTargetForNode,
} from '../tree/treeOperations';
import { buildRefDisplay } from '../tree/refDisplay';
import { hasVisibleEndNode } from '../../store/generatedNavigation';
import './TreePanel.css';

export { END_NODE_ID };

export function TreePanel({
  project, projectType, selectedId, selectedIds, onSelect, onReorder, onMoveToMenu,
  onAddMenu, onAddStory, onImportFolder, onDeleteMenu, onDeleteItem, onUnpackZip, onSimulateZip,
  onBulkDeleteItems, onBulkUpdateItems,
  onPasteEntries, onCutPasteEntries, onSetMenuAsRoot, onDemoteRootToMenu, onSelectionChange, onDuplicate, onSetNodeColor,
  onAddEndNode, onRemoveEndNode, onSimulateNode,
  pathAudit, validationIssues: validationIssuesProp, projectIndex,
  treeSearchFocusTrigger = 0,
  selectionRevealRequest = null,
  showNavigationBadges = true,
  showTreeGuides = true,
}) {
  const { activeDropZone } = useMediaTransfer();
  const [ctxMenu, setCtxMenu] = useState(null);
  const [collapsedIds, setCollapsedIds] = useState(new Set());
  const [hoverScopeParentId, setHoverScopeParentId] = useState(null);
  const [hoverGuide, setHoverGuide] = useState(null);
  const osDropHover = activeDropZone === 'treepanel';

  const isExpanded = useCallback((id) => !collapsedIds.has(id), [collapsedIds]);
  const treeScrollRef = useRef(null);

  const rootEntries = project.rootEntries ?? [];
  const validationIssues = validationIssuesProp ?? [];

  const flatNodes = useMemo(() => {
    const nodes = [{ id: 'root', type: 'root', level: 0 }];
    if (projectType === 'pack') {
      nodes.push(...projectIndex.flatEntries.map((entry) => ({
        id: entry.id,
        type: entry.type,
        level: entry.level,
      })));
      if (hasVisibleEndNode(project)) {
        nodes.push({ id: END_NODE_ID, type: END_NODE_ID, level: 0 });
      }
    }
    return nodes;
  }, [project, projectIndex, projectType]);
  const flatNodeIndexById = useMemo(
    () => new Map(flatNodes.map((node, index) => [node.id, index])),
    [flatNodes],
  );
  const getEntry = useCallback((entryId) => projectIndex.entryById.get(entryId) ?? null, [projectIndex]);
  const getParentId = useCallback((entryId) => projectIndex.parentMenuById.get(entryId) ?? null, [projectIndex]);
  const {
    anchorIdRef,
    callOnSelect,
    handleNodeSelect,
  } = useTreeSelection({
    selectedIds,
    selectedId,
    onSelect,
    onSelectionChange,
    flatNodes,
    flatNodeIndexById,
  });

  const handleToggleExpand = useCallback((id) => {
    // Dossier dans une multi-selection : on applique le meme repli/depli a tous
    // les dossiers selectionnes. L'etat cible suit le dossier sur lequel on clique.
    const targets = selectedIds.has(id) && selectedIds.size > 1
      ? [...selectedIds].filter((sid) => getEntry(sid)?.type === 'menu')
      : [id];
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      const willCollapse = !next.has(id);
      for (const folderId of (targets.length > 0 ? targets : [id])) {
        if (willCollapse) next.add(folderId);
        else next.delete(folderId);
      }
      return next;
    });
  }, [selectedIds, getEntry]);

  const ancestorIds = useMemo(() => {
    const ancestors = new Set();
    for (const id of selectedIds) {
      if (id === 'root' || id === END_NODE_ID) continue;
      let parentId = getParentId(id);
      while (parentId != null) {
        ancestors.add(parentId);
        parentId = getParentId(parentId);
      }
    }
    return ancestors;
  }, [selectedIds, getParentId]);

  const activeScopeParentId = useMemo(() => {
    if (!selectedId || selectedId === 'root' || selectedId === END_NODE_ID) return null;
    return getParentId(selectedId) ?? 'root';
  }, [selectedId, getParentId]);

  const guideScopeIdsById = useMemo(
    () => buildGuideScopeIdsById(projectIndex),
    [projectIndex],
  );

  const clearHoverScope = useCallback(() => {
    setHoverScopeParentId(null);
    setHoverGuide(null);
  }, []);

  const handleHoverScope = useCallback((parentScopeId, level, enableScope) => {
    const nextGuide = getNextHoverGuide(parentScopeId, level);
    setHoverGuide((prev) => (
      sameHoverGuide(prev, nextGuide)
        ? prev
        : nextGuide
    ));
    const nextScopeParentId = enableScope ? (parentScopeId ?? null) : null;
    setHoverScopeParentId((prev) => (prev === nextScopeParentId ? prev : nextScopeParentId));
  }, []);

  const { navigationBadgesById, endNodeNavigationBadges, hasEndNode } = useTreeNavigationBadges({
    project,
    projectIndex,
    projectType,
    showNavigationBadges,
    validationIssues,
  });

  const {
    searchActive,
    setSearchActive,
    searchTerm,
    setSearchTerm,
    searchInputRef,
    visibleIds,
  } = useTreeSearch({ projectIndex, projectType, treeSearchFocusTrigger });

  const lastRevealRequestRef = useRef(null);
  useEffect(() => {
    const requestId = selectionRevealRequest?.requestId;
    const targetId = selectionRevealRequest?.id;
    if (!requestId || !targetId || lastRevealRequestRef.current === requestId) return undefined;

    if (visibleIds && targetId !== 'root' && targetId !== END_NODE_ID && !visibleIds.has(targetId)) {
      setSearchTerm('');
      setSearchActive(false);
    }

    if (targetId !== 'root' && targetId !== END_NODE_ID) {
      setCollapsedIds((current) => {
        const next = new Set(current);
        let changed = false;
        let parentId = getParentId(targetId);
        while (parentId != null) {
          changed = next.delete(parentId) || changed;
          parentId = getParentId(parentId);
        }
        return changed ? next : current;
      });
    }

    let frameId = null;
    let attempts = 0;
    const reveal = () => {
      const host = treeScrollRef.current;
      const target = host
        ? [...host.querySelectorAll('[data-tree-node-id]')]
          .find((node) => node.dataset.treeNodeId === String(targetId))
        : null;
      if (target) {
        lastRevealRequestRef.current = requestId;
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        return;
      }
      attempts += 1;
      if (attempts < 3) frameId = requestAnimationFrame(reveal);
      else lastRevealRequestRef.current = requestId;
    };
    frameId = requestAnimationFrame(reveal);
    return () => {
      if (frameId != null) cancelAnimationFrame(frameId);
    };
  }, [getParentId, selectionRevealRequest, setSearchActive, setSearchTerm, visibleIds]);

  const {
    clipboardRef,
    cutIds,
    getTopLevelSelected,
    handleCopy,
    handleCut,
    handlePaste,
    handlePasteMedia,
    handleReplaceAudio,
    deleteSelectedNodes,
  } = useTreeClipboard({
    selectedId,
    selectedIds,
    getEntry,
    getParentId,
    onPasteEntries,
    onCutPasteEntries,
    onBulkDeleteItems,
    onRemoveEndNode,
    onSelectionChange,
    callOnSelect,
  });

  const getContainerEntries = useCallback((containerId) => {
    if (containerId == null) return rootEntries;
    const container = getEntry(containerId);
    return container?.type === 'menu' ? (container.children ?? []) : [];
  }, [getEntry, rootEntries]);

  const {
    activeId,
    dropInfo,
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  } = useTreeDnd({
    projectIndex,
    selectedIds,
    flatNodes,
    getEntry,
    getParentId,
    getContainerEntries,
    onReorder,
    onMoveToMenu,
  });

  useEffect(() => {
    if (activeId) {
      setHoverScopeParentId(null);
      setHoverGuide(null);
    }
  }, [activeId]);

  function handleKeyDown(e) {
    if (!selectedId) return;
    const idx = flatNodeIndexById.get(selectedId) ?? -1;
    if (idx === -1) return;

    // Navigation a11y standard — non configurable.
    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (idx > 0) handleNodeSelect(flatNodes[idx - 1].id, e.shiftKey ? e : null);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();
      if (idx < flatNodes.length - 1) handleNodeSelect(flatNodes[idx + 1].id, e.shiftKey ? e : null);
      return;
    }

    // Raccourcis configurables (scope 'tree').
    const actionId = findShortcutAction(e, getCurrentShortcuts(), 'tree');
    if (!actionId) return;
    e.preventDefault();
    if (actionId === 'treeCopy') handleCopy();
    else if (actionId === 'treeCut') handleCut();
    else if (actionId === 'treePaste') handlePaste();
    else if (actionId === 'treeDelete') void deleteSelectedNodes();
  }

  const handleContextMenu = useCallback((e, nodeId, nodeType) => {
    e.preventDefault();
    e.stopPropagation();
    if (projectType !== 'pack') return;
    if (!selectedIds.has(nodeId)) {
      // Emettre la selection AVANT callOnSelect : le menu doit refleter le seul
      // noeud vise, pas une ancienne multi (evite une action groupee surprise).
      onSelectionChange?.(new Set([nodeId]));
      anchorIdRef.current = nodeId;
      callOnSelect(nodeId);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, nodeType });
  }, [anchorIdRef, callOnSelect, onSelectionChange, projectType, selectedIds]);

  function renderEntries(entries, level, parentMenu = null, { sortable = true } = {}) {
    const filtered = visibleIds ? entries.filter((e) => visibleIds.has(e.id)) : entries;
    if (!filtered?.length) return null;
    const parentScopeId = parentMenu?.id ?? 'root';
    const content = filtered.map((entry) => (
          <Fragment key={entry.id}>
            <TreeNode
              id={entry.id}
              type={entry.type}
              label={entry.type === 'ref' ? buildRefDisplay(entry, projectIndex.entryById).label : entry.name}
              level={level}
              selected={selectedIds.has(entry.id)}
              cut={cutIds.has(entry.id)}
              color={entry.treeColor}
              isAncestor={ancestorIds.has(entry.id)}
              isActiveScope={activeScopeParentId === parentScopeId}
              isHoverScope={hoverScopeParentId === parentScopeId}
              isHoverGuide={isEntryInHoverGuide({
                entryId: entry.id,
                level,
                hoverGuide,
                guideScopeIdsById,
              })}
              dragging={!!activeId}
              containerDroppableId={sortable && entry.type === 'menu' ? `container:${entry.id}` : null}
              navigationBadges={navigationBadgesById.get(entry.id) ?? EMPTY_BADGES}
              showNavigationBadgeColumn={showNavigationBadgeColumn}
              expanded={isExpanded(entry.id)}
              onToggleExpand={handleToggleExpand}
              childCount={countDescendants(entry)}
              sortable={sortable}
              dropTarget={resolveDropTargetForNode(entry.id, entry.type, dropInfo)}
              suppressSortAnimation={suppressSortAnimation}
              onSelect={handleNodeSelect}
              onContextMenu={handleContextMenu}
              hoverGuideScopeIds={guideScopeIdsById.get(entry.id)}
              hoverGuideLevel={hoverGuide?.level ?? null}
              hoverScopeEnabled={sortable && entry.type === 'menu'}
              onHoverScope={sortable ? handleHoverScope : undefined}
            />
            {entry.type === 'menu' && isExpanded(entry.id)
              ? renderEntries(entry.children ?? [], level + 1, entry, { sortable })
              : null}
          </Fragment>
    ));
    return sortable ? (
      <SortableContext items={filtered.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
        {content}
      </SortableContext>
    ) : content;
  }

  const nightModeActive = !!project.globalOptions?.nightMode;
  const showNavigationBadgeColumn = projectType === 'pack' && showNavigationBadges;

  const prevHasEndNodeRef = useRef(hasEndNode);
  useEffect(() => {
    if (!prevHasEndNodeRef.current && hasEndNode && treeScrollRef.current) {
      treeScrollRef.current.scrollTop = treeScrollRef.current.scrollHeight;
    }
    prevHasEndNodeRef.current = hasEndNode;
  }, [hasEndNode]);

  const activeEntry = activeId ? getEntry(activeId) : null;
  // Garde le dossier survolé stable pendant qu'on vise : on fige la sort-animation
  // dès qu'on survole un dossier (pas seulement une fois "dedans"), pour qu'il ne
  // glisse plus sous le curseur et qu'on déborde moins en avant/après.
  const overEntry = activeId && dropInfo.targetId ? getEntry(dropInfo.targetId) : null;
  const suppressSortAnimation = !!activeId && !dropInfo.isContainer
    && (dropInfo.position === 'inside' || overEntry?.type === 'menu');

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="tree-shell" data-os-drop-zone="treepanel">
          {projectType === 'pack' && searchActive ? (
            <TreeSearchBar
              searchTerm={searchTerm}
              setSearchTerm={setSearchTerm}
              setSearchActive={setSearchActive}
              inputRef={searchInputRef}
            />
          ) : null}
          <div
            ref={treeScrollRef}
            className={`tree${showTreeGuides ? '' : ' tree--no-guides'}`}
            tabIndex={0}
            onPointerDownCapture={() => treeScrollRef.current?.focus({ preventScroll: true })}
            onKeyDown={handleKeyDown}
            onContextMenu={(e) => handleContextMenu(e, 'root', 'root-bg')}
            onPointerLeave={clearHoverScope}
            style={{ outline: 'none' }}
            data-media-node-id="root"
            data-media-node-type="root"
          >
            <TreeNode
              id="root"
              type="root"
              label={projectType === 'pack'
                ? (project.rootName || 'Menu racine')
                : (project.projectName || 'Mon histoire')}
              level={0}
              selected={selectedIds.has('root')}
              color={project.treeColor}
              dragging={!!activeId}
              containerDroppableId="container:root"
              navigationBadges={showNavigationBadgeColumn && project?.nativeGraph?.preserveForRoundTrip === true ? [{
                key: 'native-graph-root',
                kind: 'graph',
                label: 'Graphe',
                title: 'Graphe interactif natif actif pour le round-trip.',
              }] : EMPTY_BADGES}
              showNavigationBadgeColumn={showNavigationBadgeColumn}
              dropTarget={resolveDropTargetForNode('root', 'root', dropInfo)}
              suppressSortAnimation={suppressSortAnimation}
              onSelect={handleNodeSelect}
              onContextMenu={handleContextMenu}
            />

            {projectType === 'pack' ? renderEntries(rootEntries, 1, null) : null}

            {hasEndNode ? <div className="tree-end-node-sep" /> : null}
            {hasEndNode ? (
              <div
                className="tree-end-node-wrap"
                onContextMenu={(e) => handleContextMenu(e, END_NODE_ID, END_NODE_ID)}
              >
                <TreeNode
                  id={END_NODE_ID}
                  type="end-node"
                  icon={nightModeActive ? 'moon' : 'stop'}
                  label={`${project.endNodeName || 'Message de fin'}${nightModeActive ? ' (mode nuit)' : ''}`}
                  level={0}
                  selected={selectedIds.has(END_NODE_ID)}
                  dragging={false}
                  navigationBadges={showNavigationBadgeColumn ? endNodeNavigationBadges : EMPTY_BADGES}
                  showNavigationBadgeColumn={showNavigationBadgeColumn}
                  onSelect={handleNodeSelect}
                  onContextMenu={handleContextMenu}
                />
              </div>
            ) : null}
          </div>

        {osDropHover && (
          <div className="tree-os-drop-overlay">
            Déposer pour ajouter au projet
          </div>
        )}
        </div>

        <DragOverlay>
          <TreeDragOverlay entry={activeEntry} />
        </DragOverlay>
      </DndContext>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          actions={buildTreeContextActions({
            nodeId: ctxMenu.nodeId,
            nodeType: ctxMenu.nodeType,
            project,
            projectType,
            selectedIds,
            getEntry,
            getParentId,
            clipboardRef,
            getTopLevelSelected,
            handleCopy,
            handleCut,
            handlePaste,
            handlePasteMedia,
            handleReplaceAudio,
            callOnSelect,
            onSelectionChange,
            onAddMenu,
            onAddStory,
            onImportFolder,
            onAddEndNode,
            onRemoveEndNode,
            onDemoteRootToMenu,
            onSetMenuAsRoot,
            onSimulateZip,
            onUnpackZip,
            onSimulateNode,
            onMoveToMenu,
            onDuplicate,
            onDeleteMenu,
            onDeleteItem,
            onBulkDeleteItems,
            onBulkUpdateItems,
            onSetNodeColor,
            closeContextMenu: () => setCtxMenu(null),
          })}
        />
      )}
    </>
  );
}
