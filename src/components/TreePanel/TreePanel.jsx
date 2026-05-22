import { revealItemInDir } from '@tauri-apps/plugin-opener';
import {
  DndContext, closestCenter, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext, verticalListSortingStrategy, arrayMove,
} from '@dnd-kit/sortable';
import { Fragment, useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { TreeNode } from './TreeNode';
import { ContextMenu } from './ContextMenu';
import {
  IconArchive,
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
import { useSharedClipboard } from '../../store/useSharedClipboard';
import { getItemValidationStatus, getMenuValidationStatus, getRootValidationStatus, getEndNodeValidationStatus } from '../../store/projectValidation';
import {
  getGeneratedEndNodeHomeNavigation,
  getGeneratedNavigationTargetName,
  getGeneratedStoryNavigation,
  hasVisibleEndNode,
} from '../../store/generatedNavigation';
import './TreePanel.css';

const EMPTY_BADGES = [];
const TREE_COLOR_PALETTE = ['#e24b4a', '#ef9f27', '#f0c84b', '#5fbf6b', '#3d9be9', '#7c6af7', '#d95bb4'];

function containsMenu(entry, targetMenuId) {
  if (!entry || entry.type !== 'menu') return false;
  if (entry.id === targetMenuId) return true;
  return (entry.children ?? []).some((child) => containsMenu(child, targetMenuId));
}

function wouldCreateMenuCycle(entry, targetContainerId, projectIndex = null) {
  if (targetContainerId == null || entry?.type !== 'menu') return false;
  const targetPath = projectIndex?.pathById.get(targetContainerId) ?? null;
  if (targetPath) {
    return targetPath.some((ancestor) => ancestor.id === entry.id);
  }
  return containsMenu(entry, targetContainerId);
}

function hasSelectedAncestor(entryId, candidateIds, getParentId) {
  let parentId = getParentId(entryId);
  while (parentId != null) {
    if (candidateIds.has(parentId)) return true;
    parentId = getParentId(parentId);
  }
  return false;
}

function getEndNodeNavigationBadges(entry, parentMenu, project, rootEntries, projectIndex) {
  const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries);
  const targetId = navigation.endNodeReturn.targetId;
  if (!targetId) return [];

  const isNightMode = navigation.endNodeReturn.isNightMode;
  const targetName = getGeneratedNavigationTargetName(targetId, projectIndex);
  const nightSuffix = isNightMode ? ' (mode nuit)' : '';
  const title = navigation.endNodeReturn.isImportedPrompt
    ? `Retour modifié : fin de lecture, nœud de fin intégré${nightSuffix} → « ${targetName} »`
    : `Retour modifié : fin de lecture via nœud de fin${nightSuffix} → « ${targetName} »`;

  return [{
    key: `end-node-return:${targetId}:${targetName}`,
    kind: isNightMode ? 'end-night' : 'end-node',
    label: isNightMode ? '☾' : '■',
    title,
  }];
}

function getStrongestStatus(issues = []) {
  if (issues.some((issue) => issue.status === 'error')) return 'error';
  if (issues.some((issue) => issue.status === 'warn' || issue.status === 'warning')) return 'warn';
  return null;
}

function getNavigationBadges(entry, parentMenu, issuesById, projectIndex, project, rootEntries) {
  if (entry?.type === 'menu' && entry.nativeGraph?.preserveForRoundTrip === true) {
    return [{
      key: 'native-graph',
      kind: 'graph',
      label: '◇',
      title: 'Graphe interactif natif préservé pour le round-trip.',
    }];
  }
  if (entry?.type === 'menu' && entry.importedContinuation) {
    return [{
      key: 'continuation',
      kind: 'continuation',
      label: '⇒',
      title: `Continuation native importée depuis ${entry.importedContinuation.sourceStoryName || 'une histoire'}.`,
    }];
  }
  if (entry?.type !== 'story') return [];

  const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries);
  const endNodeBadges = getEndNodeNavigationBadges(entry, parentMenu, project, rootEntries, projectIndex);
  const badges = [];

  const entryIssues = issuesById.get(entry.id) ?? [];
  const homeStatus = getStrongestStatus(entryIssues.filter((issue) => issue.text.includes('destination bouton Accueil') || issue.text.includes('destination Home spécifique inutile')));

  if (!navigation.directReturn.isBypassedByEndNode) {
    const returnStatus = getStrongestStatus(entryIssues.filter((issue) => issue.text.includes('destination de retour')));
    if (navigation.directReturn.isModified) {
      const returnName = getGeneratedNavigationTargetName(navigation.directReturn.targetId, projectIndex);
      badges.push({
        key: `return:${navigation.directReturn.targetId}:${returnName}`,
        kind: 'return',
        status: returnStatus,
        label: '↩',
        title: `Retour modifié : après lecture → « ${returnName} »`,
      });
    }
  }

  if (!navigation.endNodeReturn.isImportedPrompt && navigation.promptReturn.isConfigured && navigation.promptReturn.targetId) {
    const promptReturnName = getGeneratedNavigationTargetName(navigation.promptReturn.targetId, projectIndex);
    badges.push({
      key: `prompt-return:${navigation.promptReturn.targetId}:${promptReturnName}`,
      kind: 'prompt-return',
      status: navigation.promptReturn.isInactive ? 'warn' : null,
      label: '↩',
      title: navigation.promptReturn.isImportedNightPrompt
        ? `Retour modifié : fin de lecture, message du nœud de fin intégré → « ${promptReturnName} »`
        : `Retour modifié : fin de lecture via message de fin → « ${promptReturnName} »`,
    });
  }

  if (navigation.storyHome.isNone) {
    badges.push({
      key: 'home:none',
      kind: 'home-none',
      status: homeStatus,
      label: '⌂',
      title: 'Retour modifié : bouton Home pendant la lecture → aucune transition',
    });
  } else if (navigation.storyHome.isConfigured) {
    const homeName = getGeneratedNavigationTargetName(navigation.storyHome.targetId, projectIndex);
    badges.push({
      key: `home:${navigation.storyHome.targetId}:${homeName}`,
      kind: 'home',
      status: navigation.storyHome.isInactive ? 'warn' : homeStatus,
      label: '⌂',
      title: navigation.storyHome.isInactive
        ? `Retour modifié : bouton Home configuré vers « ${homeName} », mais le bouton Accueil est désactivé pendant la lecture`
        : `Retour modifié : bouton Home → « ${homeName} »`,
    });
  }

  if (navigation.promptHome.isNone) {
    badges.push({
      key: 'prompt-home:none',
      kind: 'prompt-home-none',
      status: navigation.promptHome.isInactive ? 'warn' : null,
      label: '⌂',
      title: 'Retour modifié : bouton Home du message de fin → aucune transition',
    });
  } else if (navigation.promptHome.isConfigured) {
    const promptHomeName = getGeneratedNavigationTargetName(navigation.promptHome.targetId, projectIndex);
    badges.push({
      key: `prompt-home:${navigation.promptHome.targetId}:${promptHomeName}`,
      kind: 'prompt-home',
      status: navigation.promptHome.isInactive ? 'warn' : null,
      label: '⌂',
      title: navigation.promptHome.isInactive
        ? `Retour modifié : bouton Home du message de fin configuré vers « ${promptHomeName} », mais le bouton Accueil est désactivé sur ce message`
        : `Retour modifié : bouton Home du message de fin → « ${promptHomeName} »`,
    });
  }

  badges.push(...endNodeBadges);

  return badges;
}

function resolveDropContainerId(over, overData, overEntry, isContainerDrop, getParentId) {
  if (isContainerDrop) {
    if (overData && Object.prototype.hasOwnProperty.call(overData, 'containerId')) {
      return overData.containerId;
    }
    return over.id === 'container:root' ? null : String(over.id).replace(/^container:/, '');
  }
  if (over.id === 'root') return null;
  return overEntry?.type === 'menu' ? overEntry.id : getParentId(over.id);
}


export const END_NODE_ID = 'end-node';

const EMPTY_DROP_INFO = { targetId: null, position: 'inside', isContainer: false };

function countDescendants(entry) {
  if (!entry.children?.length) return 0;
  return entry.children.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

export function TreePanel({
  project, projectType, selectedId, onSelect, onReorder, onMoveToMenu,
  onAddMenu, onAddStory, onImportFolder, onDeleteMenu, onDeleteItem, onUnpackZip, onSimulateZip,
  onBulkDeleteItems,
  onPasteEntries, onCutPasteEntries, onSetMenuAsRoot, onDemoteRootToMenu, onSelectionChange, onDuplicate, onSetNodeColor,
  onAddEndNode, onRemoveEndNode, onSimulateNode,
  pathAudit, validationIssues: validationIssuesProp, projectIndex,
  treeSearchFocusTrigger = 0,
}) {
  const [activeId, setActiveId] = useState(null);
  const [dropInfo, setDropInfo] = useState(EMPTY_DROP_INFO);
  const dropInfoRef = useRef(EMPTY_DROP_INFO);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [collapsedIds, setCollapsedIds] = useState(new Set());
  const [osDropHover, setOsDropHover] = useState(false);

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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const collisionDetection = useCallback((args) => {
    const pointerHits = pointerWithin(args);
    return pointerHits.length > 0 ? pointerHits : closestCenter(args);
  }, []);

  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const anchorIdRef = useRef(selectedId);
  const clipboardRef = useSharedClipboard(); // { entries, isCut, sourceIds } — partagé avec le diagramme
  const [cutIds, setCutIds] = useState(new Set());
  const skipSyncRef = useRef(false);

  const callOnSelect = useCallback((id) => {
    skipSyncRef.current = true;
    onSelect(id);
  }, [onSelect]);

  const prevSelectedIdRef = useRef(selectedId);
  useEffect(() => {
    if (selectedId !== prevSelectedIdRef.current) {
      prevSelectedIdRef.current = selectedId;
      if (skipSyncRef.current) {
        skipSyncRef.current = false;
      } else {
        setSelectedIds(new Set([selectedId]));
        anchorIdRef.current = selectedId;
      }
    }
  }, [selectedId]);

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
    }
    return nodes;
  }, [projectIndex, projectType]);
  const flatNodeIndexById = useMemo(
    () => new Map(flatNodes.map((node, index) => [node.id, index])),
    [flatNodes],
  );
  const getEntry = useCallback((entryId) => projectIndex.entryById.get(entryId) ?? null, [projectIndex]);
  const getParentId = useCallback((entryId) => projectIndex.parentMenuById.get(entryId) ?? null, [projectIndex]);

  const ancestorIds = useMemo(() => {
    const ancestors = new Set();
    for (const id of selectedIds) {
      if (id === 'root' || id === END_NODE_ID) continue;
      const parentId = getParentId(id);
      if (parentId != null) ancestors.add(parentId);
    }
    return ancestors;
  }, [selectedIds, getParentId]);

  // Compute drop position (before / after / inside) from the active element's rect vs the hovered element.
  // For menus: top 30% → before, middle 40% → inside, bottom 30% → after.
  // For stories/zip: top half → before, bottom half → after.
  const computeDropInfo = useCallback((over, activeRect) => {
    if (!over) return EMPTY_DROP_INFO;

    const overData = over.data.current;
    if (overData?.kind === 'container') {
      return { targetId: overData.containerId, position: 'inside', isContainer: true };
    }

    const targetId = String(over.id);
    if (targetId === 'root') {
      return { targetId: null, position: 'inside', isContainer: true };
    }

    const entry = getEntry(targetId);
    const overRect = over.rect;
    if (!overRect || !activeRect) {
      return { targetId, position: 'inside', isContainer: false };
    }

    const activeMidY = activeRect.top + activeRect.height / 2;

    if (entry?.type === 'menu') {
      const zone = Math.min(overRect.height * 0.18, 6);
      const relativeY = activeMidY - overRect.top;
      if (relativeY < zone) return { targetId, position: 'before', isContainer: false };
      if (relativeY > overRect.height - zone) return { targetId, position: 'after', isContainer: false };
      return { targetId, position: 'inside', isContainer: false };
    }

    const overMidY = overRect.top + overRect.height / 2;
    return { targetId, position: activeMidY < overMidY ? 'before' : 'after', isContainer: false };
  }, [getEntry]);

  const handleDragMove = useCallback((event) => {
    const { active, over } = event;
    const newInfo = over
      ? computeDropInfo(over, active.rect.current?.translated ?? null)
      : EMPTY_DROP_INFO;
    const prev = dropInfoRef.current;
    if (prev.targetId !== newInfo.targetId || prev.position !== newInfo.position || prev.isContainer !== newInfo.isContainer) {
      dropInfoRef.current = newInfo;
      setDropInfo(newInfo);
    }
  }, [computeDropInfo]);
  const entryNameSignature = projectIndex.flatEntries
    .map(({ id, entry }) => `${id}:${entry.name ?? ''}`)
    .join('\n');

  const navigationBadgesById = useMemo(() => {
    const badgesById = new Map();
    if (projectType !== 'pack') return badgesById;
    for (const flatEntry of projectIndex.flatEntries) {
      const entry = flatEntry.entry;
      if (entry.type !== 'story') continue;
      const parentMenuId = projectIndex.parentMenuById.get(entry.id);
      const parentMenu = parentMenuId ? (projectIndex.entryById.get(parentMenuId) ?? null) : null;
      badgesById.set(entry.id, getNavigationBadges(
        entry,
        parentMenu,
        issuesById,
        projectIndex,
        project,
        rootEntries,
      ));
    }
    return badgesById;
  }, [
    issuesById,
    project,
    entryNameSignature,
    projectIndex,
    projectType,
    rootEntries,
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

  function handleNodeSelect(id, e) {
    const isCtrl = e?.ctrlKey || e?.metaKey;
    const isShift = e?.shiftKey;

    if (id === END_NODE_ID) {
      const single = new Set([END_NODE_ID]);
      setSelectedIds(single);
      onSelectionChange?.(single);
      anchorIdRef.current = END_NODE_ID;
      callOnSelect(END_NODE_ID);
      return;
    }

    if (isCtrl && !isShift) {
      if (id === 'root') {
        setSelectedIds(new Set(['root']));
        anchorIdRef.current = 'root';
        callOnSelect('root');
        return;
      }
      const next = new Set([...selectedIds].filter((currentId) => currentId !== END_NODE_ID));
      if (next.has(id)) {
        next.delete(id);
        if (next.size === 0) next.add(id);
        if (id === selectedId) {
          const fallback = [...next].find((currentId) => currentId !== id) ?? 'root';
          callOnSelect(fallback);
        }
      } else {
        next.add(id);
        anchorIdRef.current = id;
        callOnSelect(id);
      }
      setSelectedIds(next);
      onSelectionChange?.(next);
    } else if (isShift && anchorIdRef.current) {
      const anchorIdx = flatNodeIndexById.get(anchorIdRef.current) ?? -1;
      const currentIdx = flatNodeIndexById.get(id) ?? -1;
      if (anchorIdx === -1 || currentIdx === -1) {
        callOnSelect(id);
        const single = new Set([id]);
        setSelectedIds(single);
        onSelectionChange?.(single);
        return;
      }
      const [start, end] = anchorIdx <= currentIdx ? [anchorIdx, currentIdx] : [currentIdx, anchorIdx];
      const next = isCtrl
        ? new Set([...selectedIds].filter((currentId) => currentId !== END_NODE_ID))
        : new Set();
      for (let i = start; i <= end; i += 1) {
        if (flatNodes[i].id !== 'root') next.add(flatNodes[i].id);
      }
      next.add(anchorIdRef.current);
      if (next.size === 0) next.add(id);
      setSelectedIds(next);
      onSelectionChange?.(next);
      callOnSelect(id);
    } else {
      const single = new Set([id]);
      setSelectedIds(single);
      onSelectionChange?.(single);
      anchorIdRef.current = id;
      callOnSelect(id);
    }
  }

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

  function handleKeyDown(e) {
    if (!selectedId) return;
    const idx = flatNodeIndexById.get(selectedId) ?? -1;
    if (idx === -1) return;

    if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      if (idx > 0) handleNodeSelect(flatNodes[idx - 1].id, e.shiftKey ? e : null);
    } else if (e.key === 'ArrowDown' || e.key === 'Tab') {
      e.preventDefault();
      if (idx < flatNodes.length - 1) handleNodeSelect(flatNodes[idx + 1].id, e.shiftKey ? e : null);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      deleteSelectedNodes();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'c') {
      e.preventDefault();
      handleCopy();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'x') {
      e.preventDefault();
      handleCut();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'v') {
      e.preventDefault();
      handlePaste();
    }
  }

  function handleDragEnd(event) {
    const { active, over } = event;
    // Snapshot the final drop position before clearing state
    const finalDropInfo = over
      ? computeDropInfo(over, active.rect.current?.translated ?? null)
      : null;

    setActiveId(null);
    dropInfoRef.current = EMPTY_DROP_INFO;
    setDropInfo(EMPTY_DROP_INFO);

    if (!over || active.id === over.id) return;
    const activeEntry = getEntry(active.id);
    if (!activeEntry) return;
    const fromContainerId = getParentId(active.id);

    // Resolve the target container, optional anchor, and insert position from drop info
    let targetContainerId, anchorId, insertPosition;

    if (!finalDropInfo || finalDropInfo.isContainer) {
      // Dropped on an explicit container droppable (root zone, root-exit, container:xxx)
      targetContainerId = finalDropInfo?.targetId ?? null;
      anchorId = null;
      insertPosition = 'inside';
    } else if (finalDropInfo.position === 'inside') {
      // Dropped on the middle zone of a menu → drop inside that menu
      const targetEntry = finalDropInfo.targetId ? getEntry(finalDropInfo.targetId) : null;
      targetContainerId = targetEntry?.type === 'menu'
        ? targetEntry.id
        : getParentId(finalDropInfo.targetId);
      anchorId = null;
      insertPosition = 'inside';
    } else {
      // Dropped before/after a specific item → insert next to it
      anchorId = finalDropInfo.targetId;
      if (anchorId === active.id) return; // Guard: hovering own element
      targetContainerId = getParentId(anchorId) ?? null;
      insertPosition = finalDropInfo.position; // 'before' | 'after'
    }

    if (wouldCreateMenuCycle(activeEntry, targetContainerId, projectIndex)) return;

    // Same-container reorder (before/after a sibling)
    if (fromContainerId === targetContainerId) {
      if (!anchorId) return; // Dropped on own container without specific anchor → no-op
      const items = getContainerEntries(fromContainerId);
      const isMulti = selectedIds.size > 1 && selectedIds.has(active.id) && !selectedIds.has(anchorId);
      if (isMulti) {
        // Move all selected siblings to the anchor position, preserving their relative order.
        const selectedInOrder = items.filter((item) => selectedIds.has(item.id));
        const rest = items.filter((item) => !selectedIds.has(item.id));
        const anchorIdx = rest.findIndex((item) => item.id === anchorId);
        if (anchorIdx === -1) return;
        const insertIdx = insertPosition === 'after' ? anchorIdx + 1 : anchorIdx;
        onReorder(fromContainerId, [
          ...rest.slice(0, insertIdx),
          ...selectedInOrder,
          ...rest.slice(insertIdx),
        ]);
      } else {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const anchorIndex = items.findIndex((item) => item.id === anchorId);
        if (oldIndex === -1 || anchorIndex === -1 || oldIndex === anchorIndex) return;
        onReorder(fromContainerId, arrayMove(items, oldIndex, anchorIndex));
      }
      return;
    }

    // Cross-container move
    const candidateIds = selectedIds.size > 1 && selectedIds.has(active.id)
      ? flatNodes.map((node) => node.id).filter((id) => id !== 'root' && selectedIds.has(id))
      : [active.id];
    const candidateSet = new Set(candidateIds);
    const idsToMove = candidateIds.filter((id) => {
      if (id === 'root') return false;
      const entry = getEntry(id);
      if (!entry) return false;
      if (wouldCreateMenuCycle(entry, targetContainerId, projectIndex)) return false;
      if (hasSelectedAncestor(id, candidateSet, getParentId)) return false;
      return true;
    });

    for (const id of idsToMove) {
      // For single-item drags with a precise anchor, use insert position.
      // For multi-select, fall back to append (anchor would shift after first insert).
      const useAnchor = idsToMove.length === 1 && anchorId && insertPosition !== 'inside';
      onMoveToMenu(
        id,
        getParentId(id),
        targetContainerId,
        useAnchor ? anchorId : null,
        useAnchor ? insertPosition : 'inside',
      );
    }
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
      actions.push({ icon: <IconTrash />, label: 'Supprimer le nœud de fin', fn: () => onRemoveEndNode?.(), danger: true });
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
        actions.push({ icon: <IconMoon />, label: 'Ajouter un nœud de fin', fn: () => onAddEndNode?.() });
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
        const currentColor = isRootCtx ? project.treeColor : getEntry(nodeId)?.treeColor;
        actions.push('sep');
        actions.push({
          type: 'node',
          render: () => (
            <div className="ctx-color-section">
              <div className="ctx-color-header">Couleur</div>
              <div className="ctx-color-row">
                {TREE_COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`ctx-color-dot${currentColor === color ? ' is-active' : ''}`}
                    style={{ backgroundColor: color }}
                    title={color}
                    onClick={() => {
                      onSetNodeColor?.(nodeId, nodeType, color);
                      setCtxMenu(null);
                    }}
                  />
                ))}
                <button
                  type="button"
                  className={`ctx-color-clear${!currentColor ? ' is-active' : ''}`}
                  title="Aucune couleur"
                  onClick={() => {
                    onSetNodeColor?.(nodeId, nodeType, null);
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
              status={getNodeStatus(entry, () => entry.type === 'menu'
                ? getMenuValidationStatus(entry, pathAudit)
                : getItemValidationStatus(entry, pathAudit))}
              dragging={!!activeId}
              containerDroppableId={entry.type === 'menu' ? `container:${entry.id}` : null}
              navigationBadges={navigationBadgesById.get(entry.id) ?? EMPTY_BADGES}
              expanded={isExpanded(entry.id)}
              onToggleExpand={handleToggleExpand}
              childCount={countDescendants(entry)}
              sortable
              dropInfo={dropInfo}
              suppressSortAnimation={suppressSortAnimation}
              onSelect={handleNodeSelect}
              onContextMenu={handleContextMenu}
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

  const endNodeHomeBadges = (() => {
    const homeNavigation = getGeneratedEndNodeHomeNavigation(project);
    if (!hasEndNode || !homeNavigation?.targetId) return EMPTY_BADGES;
    const homeName = getGeneratedNavigationTargetName(homeNavigation.targetId, projectIndex);
    const nightSuffix = homeNavigation.isNightMode ? ' (mode nuit)' : '';
    return [{
      key: `end-node-home:${homeNavigation.targetId}:${homeName}`,
      kind: homeNavigation.isNightMode ? 'end-night-home' : 'end-node-home',
      label: '⌂',
      title: `Retour modifié : bouton Home du nœud de fin${nightSuffix} → « ${homeName} »`,
    }];
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

  useEffect(() => {
    function onZone(e) { setOsDropHover(e.detail.zone === 'treepanel'); }
    document.addEventListener('os-file-drag-zone', onZone);
    return () => document.removeEventListener('os-file-drag-zone', onZone);
  }, []);

  const activeEntry = activeId ? getEntry(activeId) : null;
  // Suppress dnd-kit's sort animation when the intent is "drop inside" a folder,
  // so the hovered folder doesn't slide away from its position.
  const suppressSortAnimation = !!activeId && dropInfo.position === 'inside' && !dropInfo.isContainer;

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={(e) => { setActiveId(e.active.id); }}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={() => { setActiveId(null); dropInfoRef.current = EMPTY_DROP_INFO; setDropInfo(EMPTY_DROP_INFO); }}
      >
        <div className="tree-shell" data-os-drop-zone="treepanel">
          {selectedIds.size > 1 ? (
            <div className="tree-multisel-bar">
              <span>{[...selectedIds].filter((id) => id !== 'root').length} éléments sélectionnés</span>
              <button type="button" className="tree-multisel-del" onClick={deleteSelectedNodes}>
                Supprimer
              </button>
            </div>
          ) : null}
          {projectType === 'pack' && searchActive ? (
            <div className="tree-search-bar">
              <span className="tree-search-icon">⌕</span>
              <input
                ref={searchInputRef}
                className="tree-search-input"
                type="text"
                placeholder="Rechercher…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onBlur={() => { if (!searchTerm) setSearchActive(false); }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setSearchTerm('');
                    setSearchActive(false);
                    searchInputRef.current?.blur();
                  }
                  e.stopPropagation();
                }}
              />
              {searchTerm ? (
                <button
                  type="button"
                  className="tree-search-clear"
                  onClick={() => { setSearchTerm(''); searchInputRef.current?.focus(); }}
                >
                  ×
                </button>
              ) : null}
            </div>
          ) : null}

          <div
            ref={treeScrollRef}
            className="tree"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onContextMenu={(e) => handleContextMenu(e, 'root', 'root-bg')}
            style={{ outline: 'none' }}
            data-media-node-id="root"
            data-media-node-type="root"
          >
            <TreeNode
              id="root"
              type="root"
              label={projectType === 'pack'
                ? (project.packMetadata?.title || project.projectName || 'Menu racine')
                : (project.projectName || 'Mon histoire')}
              level={0}
              selected={selectedIds.has('root')}
              color={project.treeColor}
              status={getNodeStatus({ id: 'root' }, () => getRootValidationStatus(project, pathAudit))}
              dragging={!!activeId}
              containerDroppableId="container:root"
              navigationBadges={project?.nativeGraph?.preserveForRoundTrip === true ? [{
                key: 'native-graph-root',
                kind: 'graph',
                label: 'Graphe',
                title: 'Graphe interactif natif actif pour le round-trip.',
              }] : EMPTY_BADGES}
              dropInfo={dropInfo}
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
                  label={nightModeActive ? 'Nœud de fin (mode nuit)' : 'Nœud de fin'}
                  level={0}
                  selected={selectedIds.has(END_NODE_ID)}
                  status={getNodeStatus({ id: END_NODE_ID }, () => getEndNodeValidationStatus(project, pathAudit))}
                  dragging={false}
                  navigationBadges={endNodeHomeBadges}
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
          {activeEntry && (
            <div className="tree-item active" style={{ opacity: 0.85, boxShadow: '0 4px 12px rgba(0,0,0,0.3)', paddingLeft: '6px' }}>
              <span className="tree-chevron-spacer" />
              <div className="tree-item-body">
                <span className="ti-icon">
                  {activeEntry.type === 'menu' ? <IconFolderOpen /> : activeEntry.type === 'zip' ? <IconArchive /> : <IconStory />}
                </span>
                <span className="ti-label">{activeEntry.name}</span>
              </div>
            </div>
          )}
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
