import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Fragment, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { TreeNode } from './TreeNode';
import { TreeSearchBar } from './TreeSearchBar';
import { TreeDragOverlay } from './TreeDragOverlay';
import { ContextMenu } from './ContextMenu';
import { useTreeDnd } from './useTreeDnd';
import { useTreeSelection } from './useTreeSelection';
import {
  buildGuideScopeIdsById,
  getNextHoverGuide,
  isEntryInHoverGuide,
  sameHoverGuide,
} from './treeGuides';
import { END_NODE_ID, EMPTY_BADGES } from './treePanelConstants';
import {
  IconArrowUpLeft,
  IconClipboardPaste,
  IconCopy,
  IconFolderOpen,
  IconFolderPlus,
  IconHouse,
  IconImport,
  IconMoon,
  IconPen,
  IconPlay,
  IconScissors,
  IconStory,
  IconTrash,
} from './TreeIcons';
import { deepCloneEntry } from '../../store/projectModel';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { useSharedClipboard } from '../../hooks/useSharedClipboard';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { findShortcutAction, getCurrentShortcuts } from '../../store/keyboardShortcuts';
import { getItemValidationStatus, getMenuValidationStatus, getRootValidationStatus, getEndNodeValidationStatus } from '../../store/projectValidation';
import {
  TREE_COLOR_PALETTE,
  countDescendants,
  hasSelectedAncestor,
  resolveDropTargetForNode,
} from '../tree/treeOperations';
import { computeBadgesData, formatBadgeTitle, getStrongestStatus } from '../tree/treeNavigationBadges';
import {
  getGeneratedEndNodeHomeNavigation,
  getGeneratedEndNodeReturnNavigation,
  getGeneratedNavigationTargetName,
  hasVisibleEndNode,
} from '../../store/generatedNavigation';
import './TreePanel.css';

export { END_NODE_ID };

export function TreePanel({
  project, projectType, selectedId, onSelect, onReorder, onMoveToMenu,
  onAddMenu, onAddStory, onImportFolder, onDeleteMenu, onDeleteItem, onUnpackZip, onSimulateZip,
  onBulkDeleteItems, onBulkUpdateItems,
  onPasteEntries, onCutPasteEntries, onSetMenuAsRoot, onDemoteRootToMenu, onSelectionChange, onDuplicate, onSetNodeColor,
  onAddEndNode, onRemoveEndNode, onSimulateNode,
  pathAudit, validationIssues: validationIssuesProp, projectIndex,
  treeSearchFocusTrigger = 0,
  showNavigationBadges = true,
}) {
  const { activeDropZone, dropOnNode } = useMediaTransfer();
  const [ctxMenu, setCtxMenu] = useState(null);
  const [collapsedIds, setCollapsedIds] = useState(new Set());
  const [hoverScopeParentId, setHoverScopeParentId] = useState(null);
  const [hoverGuide, setHoverGuide] = useState(null);
  const osDropHover = activeDropZone === 'treepanel';

  const isExpanded = useCallback((id) => !collapsedIds.has(id), [collapsedIds]);

  const handleToggleExpand = useCallback((id) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const treeScrollRef = useRef(null);
  const [searchActive, setSearchActive] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const searchInputRef = useRef(null);
  const pendingFocusRef = useRef(false);

  const clipboardRef = useSharedClipboard(); // { entries, isCut, sourceIds } — partagé avec le diagramme
  const [cutIds, setCutIds] = useState(new Set());

  const rootEntries = project.rootEntries ?? [];
  const validationIssues = validationIssuesProp ?? [];
  const issuesById = useMemo(() => {
    const map = new Map();
    for (const issue of validationIssues) {
      if (!issue?.id) continue;
      const list = map.get(issue.id) ?? [];
      list.push(issue);
      map.set(issue.id, list);
    }
    return map;
  }, [validationIssues]);

  const getNodeStatus = useCallback((entry, getFallbackStatus) => {
    const issueStatus = getStrongestStatus(issuesById.get(entry?.id) ?? []);
    return issueStatus ?? getFallbackStatus();
  }, [issuesById]);

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
    selectedIds,
    setSelectedIds,
    anchorIdRef,
    callOnSelect,
    handleNodeSelect,
  } = useTreeSelection({
    selectedId,
    onSelect,
    onSelectionChange,
    flatNodes,
    flatNodeIndexById,
  });

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

  // Cache navigation badges DATA (struct sans noms resolus). Survit aux
  // renders via useRef. Invalidation **par-entry-reference** : on ne re-calcule
  // les badges DATA que pour les entries dont la reference Zustand a change
  // (= elles ont ete mutees). Les autres reutilisent le cache.
  //
  // Trade-off assume :
  //   - Cas frequent (rename d'une story X, edit de ses media) : seule X est
  //     invalidee, les N-1 autres restent cached. **Gain principal.**
  //   - Cas marginal : si on ajoute une story juste apres Y et que Y retourne
  //     vers "next-story", le badge de Y pourrait theoriquement etre stale
  //     jusqu'a ce que Y soit re-touchee. En pratique, getGeneratedStoryNavigation
  //     n'utilise `rootEntries` que pour resoudre la cible `next-story` au
  //     niveau d'un menu, et cela n'apparait que dans le `targetId` resolu --
  //     dont la traduction en NOM se fait via formatBadgeTitle a chaque render
  //     (qui voit le projectIndex courant). Donc en pratique : ok.
  //
  // Les titres textuels sont reformates a chaque render via formatBadgeTitle,
  // donc tout rename de cible apparait immediatement dans l'UI meme si la DATA
  // n'est pas recalculee.
  const badgesDataCacheRef = useRef(new Map());
  const navigationBadgeProjectKey = [
    project?.nightModeAudio || '',
    project?.nightModeReturn || '',
    project?.globalOptions?.nightMode ? 'night' : '',
    project?.globalOptions?.endNode ? 'end' : '',
    project?.globalOptions?.autoNext ? 'auto' : '',
  ].join('|');

  const navigationBadgesById = useMemo(() => {
    const badgesById = new Map();
    if (projectType !== 'pack' || !showNavigationBadges) return badgesById;
    const cache = badgesDataCacheRef.current;
    const seenIds = new Set();

    for (const flatEntry of projectIndex.flatEntries) {
      const entry = flatEntry.entry;
      seenIds.add(entry.id);
      const parentMenuId = projectIndex.parentMenuById.get(entry.id);
      const parentMenu = parentMenuId ? (projectIndex.entryById.get(parentMenuId) ?? null) : null;
      const entryIssues = issuesById.get(entry.id);

      const cached = cache.get(entry.id);
      let data;
      if (cached
        && cached.entry === entry
        && cached.parentMenu === parentMenu
        && cached.issues === entryIssues
        && cached.rootEntries === rootEntries
        && cached.projectKey === navigationBadgeProjectKey
        && cached.showDefaultReturns === true) {
        data = cached.data;
      } else {
        data = computeBadgesData(entry, parentMenu, issuesById, project, rootEntries, {
          showDefaultReturns: true,
        });
        cache.set(entry.id, {
          entry,
          parentMenu,
          issues: entryIssues,
          rootEntries,
          projectKey: navigationBadgeProjectKey,
          showDefaultReturns: true,
          data,
        });
      }

      if (data.length > 0) {
        badgesById.set(entry.id, data.map((d) => formatBadgeTitle(d, projectIndex)).filter(Boolean));
      }
    }

    // Nettoyage des entries disparues du projet
    for (const id of cache.keys()) {
      if (!seenIds.has(id)) cache.delete(id);
    }

    return badgesById;
  }, [
    issuesById,
    project,
    projectIndex,
    projectType,
    navigationBadgeProjectKey,
    rootEntries,
    showNavigationBadges,
  ]);

  const visibleIds = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    if (!term || projectType !== 'pack') return null;
    const matching = new Set();
    for (const flatEntry of projectIndex.flatEntries) {
      if (flatEntry.entry.name?.toLowerCase().includes(term)) {
        matching.add(flatEntry.entry.id);
      }
    }
    const visible = new Set(matching);
    for (const id of matching) {
      let parentId = projectIndex.parentMenuById.get(id);
      while (parentId != null) {
        visible.add(parentId);
        parentId = projectIndex.parentMenuById.get(parentId);
      }
    }
    return visible;
  }, [searchTerm, projectIndex, projectType]);

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

  function deleteSelectedNodes() {
    const toDelete = [...selectedIds].filter((id) => id !== 'root' && id !== END_NODE_ID);
    if (toDelete.length === 0) return;
    onBulkDeleteItems?.(toDelete);
    const rootSet = new Set(['root']);
    setSelectedIds(rootSet);
    onSelectionChange?.(rootSet);
    callOnSelect('root');
  }

  function getTopLevelSelected() {
    const ids = [...selectedIds].filter((id) => id !== 'root' && id !== END_NODE_ID);
    const idSet = new Set(ids);
    return ids.filter((id) => !hasSelectedAncestor(id, idSet, getParentId));
  }

  function getPasteTargetId(nodeId) {
    if (!nodeId || nodeId === 'root') return null;
    const entry = getEntry(nodeId);
    if (entry?.type === 'menu') return nodeId;
    return getParentId(nodeId) ?? null;
  }

  function handleCopy(nodeId) {
    const topLevel = nodeId && !selectedIds.has(nodeId) ? [nodeId] : getTopLevelSelected();
    if (!topLevel.length) return;
    clipboardRef.current = {
      entries: topLevel.map((id) => deepCloneEntry(getEntry(id))).filter(Boolean),
      isCut: false,
      sourceIds: topLevel,
    };
    setCutIds(new Set());
  }

  function handleCut(nodeId) {
    const topLevel = nodeId && !selectedIds.has(nodeId) ? [nodeId] : getTopLevelSelected();
    if (!topLevel.length) return;
    clipboardRef.current = {
      entries: topLevel.map((id) => getEntry(id)).filter(Boolean),
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
      onCutPasteEntries(sourceIds, targetId);
      clipboardRef.current = null;
      setCutIds(new Set());
    } else {
      onPasteEntries(targetId, entries.map((e) => deepCloneEntry(e)));
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
    else if (actionId === 'treeDelete') deleteSelectedNodes();
  }

  const handleContextMenu = useCallback((e, nodeId, nodeType) => {
    e.preventDefault();
    e.stopPropagation();
    if (projectType !== 'pack') return;
    if (!selectedIds.has(nodeId)) {
      setSelectedIds(new Set([nodeId]));
      anchorIdRef.current = nodeId;
      callOnSelect(nodeId);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId, nodeType });
  }, [callOnSelect, projectType, selectedIds]);

  function buildActions(nodeId, nodeType) {
    const isRootCtx = nodeType === 'root' || nodeType === 'root-bg';
    const parentMenuId = isRootCtx ? null : getParentId(nodeId);
    const targetMenuId = nodeType === 'menu' ? nodeId : parentMenuId;
    const actions = [];

    if (nodeType === END_NODE_ID) {
      actions.push({ icon: <IconTrash />, label: 'Supprimer le message de fin', fn: () => onRemoveEndNode?.(), danger: true });
      return actions;
    }

    if (projectType === 'pack') {
      actions.push({ icon: <IconFolderPlus />, label: 'Créer un dossier', fn: () => onAddMenu(targetMenuId) });
      actions.push({ icon: <IconStory />, label: 'Importer des histoires', fn: () => onAddStory(targetMenuId) });
      if (onImportFolder) {
        actions.push({ icon: <IconImport />, label: 'Importer un dossier', fn: () => onImportFolder(targetMenuId) });
      }

      const hasEndNode = hasVisibleEndNode(project);
      if (isRootCtx && !hasEndNode) {
        actions.push('sep');
        actions.push({ icon: <IconMoon />, label: 'Ajouter un message de fin', fn: () => onAddEndNode?.() });
      }

      if (nodeType === 'root' && onDemoteRootToMenu && (project.rootEntries ?? []).length > 0) {
        actions.push('sep');
        actions.push({ icon: <IconArrowUpLeft />, label: 'Sortir de la racine', fn: onDemoteRootToMenu });
      }

      if (nodeType === 'menu' && onSetMenuAsRoot && project.rootEntries?.[0]?.id === nodeId) {
        actions.push('sep');
        actions.push({ icon: <IconHouse />, label: 'Définir comme racine', fn: () => onSetMenuAsRoot(nodeId) });
      }

      if (nodeType === 'zip') {
        const item = getEntry(nodeId);
        if (item?.zipPath) {
          actions.push('sep');
          actions.push({ icon: <IconPlay />, label: 'Simuler ce pack…', fn: () => onSimulateZip(item.zipPath) });
          actions.push({ icon: <IconPen />, label: "Extraire l'histoire", fn: () => onUnpackZip(nodeId) });
        }
      }

      if (onSimulateNode && (nodeType === 'root' || nodeType === 'menu' || nodeType === 'story')) {
        actions.push('sep');
        actions.push({ icon: <IconPlay />, label: 'Simuler depuis ici', fn: () => onSimulateNode(nodeId) });
      }

      if ((nodeType === 'zip' || nodeType === 'story' || nodeType === 'menu') && parentMenuId != null) {
        actions.push('sep');
        actions.push({ icon: <IconArrowUpLeft />, label: 'Sortir du dossier', fn: () => onMoveToMenu(nodeId, parentMenuId, null) });
      }

      if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
        actions.push('sep');
        actions.push({ icon: <IconCopy />, label: 'Dupliquer', fn: () => onDuplicate(nodeId) });
        actions.push({ icon: <IconClipboardPaste />, label: 'Copier', fn: () => handleCopy(nodeId) });
        actions.push({ icon: <IconScissors />, label: 'Couper', fn: () => handleCut(nodeId) });
      }

      if (clipboardRef.current?.entries?.length) {
        actions.push({ icon: <IconClipboardPaste />, label: 'Coller ici', fn: () => handlePaste(nodeId) });
      }

      if ((isRootCtx || nodeType === 'menu' || nodeType === 'story') && audioClipboard.get()) {
        const audioClip = audioClipboard.getEntry();
        const audioCount = audioClip?.paths?.length ?? 1;
        actions.push({
          icon: <IconStory />,
          label: audioClip?.mode === 'cut'
            ? (audioCount > 1 ? `Déplacer ${audioCount} sons ici` : "Déplacer l'audio ici")
            : (audioCount > 1 ? `Coller ${audioCount} sons ici` : "Coller l'audio ici"),
          fn: () => handlePasteMedia(nodeId, nodeType, 'audio'),
        });
      }

      if ((isRootCtx || nodeType === 'menu' || nodeType === 'story') && imageClipboard.get()) {
        actions.push({
          icon: <IconImport />,
          label: imageClipboard.getEntry()?.mode === 'cut' ? "Déplacer l'image ici" : "Coller l'image ici",
          fn: () => handlePasteMedia(nodeId, nodeType, 'image'),
        });
      }

      if (nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
        actions.push('sep');
        const selectedForDelete = selectedIds.has(nodeId) && selectedIds.size > 1
          ? getTopLevelSelected()
          : [nodeId];
        const deleteFn = selectedForDelete.length > 1
          ? () => {
            onBulkDeleteItems?.(selectedForDelete);
            const rootSet = new Set(['root']);
            setSelectedIds(rootSet);
            onSelectionChange?.(rootSet);
            callOnSelect('root');
          }
          : nodeType === 'menu'
            ? () => onDeleteMenu(nodeId)
            : () => onDeleteItem(nodeId);
        actions.push({
          icon: <IconTrash />,
          label: selectedForDelete.length > 1 ? `Supprimer ${selectedForDelete.length} éléments` : 'Supprimer',
          fn: deleteFn,
          danger: true,
        });
      }

      if (isRootCtx || nodeType === 'menu' || nodeType === 'story' || nodeType === 'zip') {
        const isMultiTarget = !isRootCtx && selectedIds.has(nodeId) && selectedIds.size > 1;
        const colorTargetIds = isMultiTarget
          ? getTopLevelSelected().filter((id) => id !== 'root')
          : (isRootCtx ? [] : [nodeId]);
        const includesRoot = isMultiTarget && selectedIds.has('root');

        let currentColor;
        if (isMultiTarget) {
          const colors = colorTargetIds.map((id) => getEntry(id)?.treeColor ?? null);
          if (includesRoot) colors.push(project.treeColor ?? null);
          const unique = [...new Set(colors)];
          currentColor = unique.length === 1 ? unique[0] : '__mixed__';
        } else if (isRootCtx) {
          currentColor = project.treeColor ?? null;
        } else {
          currentColor = getEntry(nodeId)?.treeColor ?? null;
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
    }

    // Afficher dans l'explorateur — uniquement pour les histoires.
    const entryForReveal = !isRootCtx ? getEntry(nodeId) : null;
    const revealFiles = [];
    if (nodeType === 'story' && entryForReveal) {
      if (entryForReveal.audio) revealFiles.push({ label: "l'audio", path: entryForReveal.audio });
      if (entryForReveal.image) revealFiles.push({ label: "l'image", path: entryForReveal.image });
    }
    if (revealFiles.length > 0) {
      actions.push('sep');
      if (revealFiles.length === 1) {
        actions.push({ icon: <IconFolderOpen />, label: "Afficher dans l'explorateur", fn: () => revealItemInDir(revealFiles[0].path) });
      } else {
        revealFiles.forEach(rf => {
          actions.push({ icon: <IconFolderOpen />, label: `Afficher ${rf.label} dans l'explorateur`, fn: () => revealItemInDir(rf.path) });
        });
      }
    }

    return actions;
  }

  function renderEntries(entries, level, parentMenu = null) {
    const filtered = visibleIds ? entries.filter((e) => visibleIds.has(e.id)) : entries;
    if (!filtered?.length) return null;
    const parentScopeId = parentMenu?.id ?? 'root';
    return (
      <SortableContext items={filtered.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
        {filtered.map((entry) => (
          <Fragment key={entry.id}>
            <TreeNode
              id={entry.id}
              type={entry.type}
              label={entry.name}
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
              status={getNodeStatus(entry, () => entry.type === 'menu'
                ? getMenuValidationStatus(entry, pathAudit)
                : getItemValidationStatus(entry, pathAudit))}
              dragging={!!activeId}
              containerDroppableId={entry.type === 'menu' ? `container:${entry.id}` : null}
              navigationBadges={navigationBadgesById.get(entry.id) ?? EMPTY_BADGES}
              showNavigationBadgeColumn={showNavigationBadgeColumn}
              expanded={isExpanded(entry.id)}
              onToggleExpand={handleToggleExpand}
              childCount={countDescendants(entry)}
              sortable
              dropTarget={resolveDropTargetForNode(entry.id, entry.type, dropInfo)}
              suppressSortAnimation={suppressSortAnimation}
              onSelect={handleNodeSelect}
              onContextMenu={handleContextMenu}
              hoverGuideScopeIds={guideScopeIdsById.get(entry.id)}
              hoverGuideLevel={hoverGuide?.level ?? null}
              hoverScopeEnabled={entry.type === 'menu'}
              onHoverScope={handleHoverScope}
            />
            {entry.type === 'menu' && isExpanded(entry.id)
              ? renderEntries(entry.children ?? [], level + 1, entry)
              : null}
          </Fragment>
        ))}
      </SortableContext>
    );
  }

  const hasEndNode = projectType === 'pack' && hasVisibleEndNode(project);
  const nightModeActive = !!project.globalOptions?.nightMode;
  const showNavigationBadgeColumn = projectType === 'pack' && showNavigationBadges;

  const endNodeNavigationBadges = (() => {
    const badges = [];
    const returnNavigation = getGeneratedEndNodeReturnNavigation(project);
    if (hasEndNode && returnNavigation) {
      const nightSuffix = project.globalOptions?.nightMode ? ' (mode nuit)' : '';
      const isNightMode = !!project.globalOptions?.nightMode;
      const returnName = returnNavigation.targetId
        ? getGeneratedNavigationTargetName(returnNavigation.targetId, projectIndex)
        : "destination de fin de l'histoire source";
      badges.push({
        key: `end-node-return:${returnNavigation.targetId || 'contextual'}:${returnName}`,
        kind: isNightMode ? 'end-night' : 'end-node',
        label: isNightMode ? '☾' : '■',
        title: `À la fin du message de fin${nightSuffix} → « ${returnName} »`,
      });
    }

    const homeNavigation = getGeneratedEndNodeHomeNavigation(project);
    if (hasEndNode && homeNavigation?.targetId) {
      const homeName = getGeneratedNavigationTargetName(homeNavigation.targetId, projectIndex);
      const nightSuffix = homeNavigation.isNightMode ? ' (mode nuit)' : '';
      badges.push({
        key: `end-node-home:${homeNavigation.targetId}:${homeName}`,
        kind: homeNavigation.isNightMode ? 'end-night-home' : 'end-node-home',
        label: '⌂',
        title: `Appuie sur le bouton Accueil du message de fin${nightSuffix} → « ${homeName} »`,
      });
    }

    return badges.length ? badges : EMPTY_BADGES;
  })();

  const prevHasEndNodeRef = useRef(hasEndNode);
  useEffect(() => {
    if (!prevHasEndNodeRef.current && hasEndNode && treeScrollRef.current) {
      treeScrollRef.current.scrollTop = treeScrollRef.current.scrollHeight;
    }
    prevHasEndNodeRef.current = hasEndNode;
  }, [hasEndNode]);

  useEffect(() => {
    if (treeSearchFocusTrigger > 0) {
      pendingFocusRef.current = true;
      setSearchActive(true);
    }
  }, [treeSearchFocusTrigger]);

  useEffect(() => {
    if (searchActive && pendingFocusRef.current && searchInputRef.current) {
      pendingFocusRef.current = false;
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, [searchActive]);

  const activeEntry = activeId ? getEntry(activeId) : null;
  // Suppress dnd-kit's sort animation when the intent is "drop inside" a folder,
  // so the hovered folder doesn't slide away from its position.
  const suppressSortAnimation = !!activeId && dropInfo.position === 'inside' && !dropInfo.isContainer;

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
            className="tree"
            tabIndex={0}
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
              status={getNodeStatus({ id: 'root' }, () => getRootValidationStatus(project, pathAudit))}
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
                  status={getNodeStatus({ id: END_NODE_ID }, () => getEndNodeValidationStatus(project, pathAudit))}
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
          actions={buildActions(ctxMenu.nodeId, ctxMenu.nodeType)}
        />
      )}
    </>
  );
}
