// Hook : encapsule toute la machinerie dnd-kit du TreePanel (sensors,
// détection de collision, position de drop calculée, gestionnaires drag start /
// move / end / cancel). Extrait de TreePanel.jsx.

import { useCallback, useRef, useState } from 'react';
import {
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import {
  filterTopLevelSelectedIds,
  wouldCreateMenuCycle,
} from '../tree/treeOperations';

const EMPTY_DROP_INFO = { targetId: null, position: 'inside', isContainer: false };

export function useTreeDnd({
  projectIndex,
  selectedIds,
  flatNodes,
  getEntry,
  getParentId,
  getContainerEntries,
  onReorder,
  onMoveToMenu,
}) {
  const [activeId, setActiveId] = useState(null);
  const [dropInfo, setDropInfo] = useState(EMPTY_DROP_INFO);
  const dropInfoRef = useRef(EMPTY_DROP_INFO);
  // Dernière position connue du curseur (coords client), capturée pendant le
  // drag. Sert à calculer avant/après/dedans par rapport au curseur plutôt
  // qu'au centre de l'élément tiré — ciblage bien plus prévisible.
  const pointerRef = useRef(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const collisionDetection = useCallback((args) => {
    pointerRef.current = args.pointerCoordinates ?? null;
    const pointerHits = pointerWithin(args);
    return pointerHits.length > 0 ? pointerHits : closestCenter(args);
  }, []);

  // Compute drop position (before / after / inside) from active rect vs hovered rect.
  // Menus : top 18% (max 6px) -> before, bottom 18% -> after, middle -> inside.
  // Stories / zip : top half -> before, bottom half -> after.
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

    // Référence verticale : le curseur si on l'a (ciblage intuitif), sinon le
    // centre de l'élément tiré (drag clavier, etc.).
    const pointerY = pointerRef.current?.y;
    const refY = Number.isFinite(pointerY) ? pointerY : activeRect.top + activeRect.height / 2;

    if (entry?.type === 'menu') {
      const zone = Math.min(overRect.height * 0.18, 6);
      const relativeY = refY - overRect.top;
      if (relativeY < zone) return { targetId, position: 'before', isContainer: false };
      if (relativeY > overRect.height - zone) return { targetId, position: 'after', isContainer: false };
      return { targetId, position: 'inside', isContainer: false };
    }

    const overMidY = overRect.top + overRect.height / 2;
    return { targetId, position: refY < overMidY ? 'before' : 'after', isContainer: false };
  }, [getEntry]);

  const handleDragStart = useCallback((event) => {
    setActiveId(event.active.id);
  }, []);

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

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
    dropInfoRef.current = EMPTY_DROP_INFO;
    setDropInfo(EMPTY_DROP_INFO);
  }, []);

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event;
    const finalDropInfo = over
      ? computeDropInfo(over, active.rect.current?.translated ?? null)
      : null;

    setActiveId(null);
    dropInfoRef.current = EMPTY_DROP_INFO;
    setDropInfo(EMPTY_DROP_INFO);

    if (!over || active.id === over.id) return;
    const activeEntry = getEntry(active.id);
    if (!activeEntry) return;

    let targetContainerId;
    let anchorId;
    let insertPosition;

    if (!finalDropInfo || finalDropInfo.isContainer) {
      targetContainerId = finalDropInfo?.targetId ?? null;
      anchorId = null;
      insertPosition = 'inside';
    } else if (finalDropInfo.position === 'inside') {
      const targetEntry = finalDropInfo.targetId ? getEntry(finalDropInfo.targetId) : null;
      targetContainerId = targetEntry?.type === 'menu'
        ? targetEntry.id
        : getParentId(finalDropInfo.targetId);
      anchorId = null;
      insertPosition = 'inside';
    } else {
      anchorId = finalDropInfo.targetId;
      if (anchorId === active.id) return;
      targetContainerId = getParentId(anchorId) ?? null;
      insertPosition = finalDropInfo.position;
    }

    const candidateIds = selectedIds.size > 1 && selectedIds.has(active.id)
      ? flatNodes.map((node) => node.id).filter((id) => id !== 'root' && selectedIds.has(id))
      : [active.id];
    const idsToMove = filterTopLevelSelectedIds(candidateIds, getParentId).filter((id) => {
      const entry = getEntry(id);
      return entry && !wouldCreateMenuCycle(entry, targetContainerId, projectIndex);
    });
    if (idsToMove.length === 0) return;

    const moveIdSet = new Set(idsToMove);
    const fromContainerId = getParentId(idsToMove[0]);
    const allFromSameContainer = idsToMove.every((id) => getParentId(id) === fromContainerId);

    // Same-container reorder
    if (allFromSameContainer && fromContainerId === targetContainerId) {
      if (!anchorId || moveIdSet.has(anchorId)) return;
      const items = getContainerEntries(fromContainerId);
      const isMulti = idsToMove.length > 1;
      if (isMulti) {
        const selectedInOrder = items.filter((item) => moveIdSet.has(item.id));
        if (selectedInOrder.length !== idsToMove.length) return;
        const rest = items.filter((item) => !moveIdSet.has(item.id));
        const anchorIdx = rest.findIndex((item) => item.id === anchorId);
        if (anchorIdx === -1) return;
        const insertIdx = insertPosition === 'after' ? anchorIdx + 1 : anchorIdx;
        onReorder(fromContainerId, [
          ...rest.slice(0, insertIdx),
          ...selectedInOrder,
          ...rest.slice(insertIdx),
        ]);
      } else {
        const oldIndex = items.findIndex((item) => item.id === idsToMove[0]);
        const anchorIndex = items.findIndex((item) => item.id === anchorId);
        if (oldIndex === -1 || anchorIndex === -1 || oldIndex === anchorIndex) return;
        onReorder(fromContainerId, arrayMove(items, oldIndex, anchorIndex));
      }
      return;
    }

    // Cross-container move
    const useAnchor = idsToMove.length === 1 && anchorId && insertPosition !== 'inside';
    if (idsToMove.length === 1) {
      onMoveToMenu(
        idsToMove[0],
        getParentId(idsToMove[0]),
        targetContainerId,
        useAnchor ? anchorId : null,
        useAnchor ? insertPosition : 'inside',
      );
    } else {
      onMoveToMenu(idsToMove, null, targetContainerId);
    }
  }, [
    computeDropInfo,
    flatNodes,
    getContainerEntries,
    getEntry,
    getParentId,
    onMoveToMenu,
    onReorder,
    projectIndex,
    selectedIds,
  ]);

  return {
    activeId,
    dropInfo,
    sensors,
    collisionDetection,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
    handleDragCancel,
  };
}
