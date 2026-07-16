import { useCallback, useEffect, useRef, useState } from 'react';
import { findParentMenuId } from '../../../store/projectModel';
import { buildTopLevelMovePlan } from '../../tree/treeOperations';
import { DRAG_START_DISTANCE, canMoveEntryToContainer } from '../flowDiagramLayout';

export function useDiagramNodeDrag({
  project,
  projectIndex,
  selectedIds,
  onMoveToMenu,
  onSelect,
  onSelectionChange,
  onDragSelect,
}) {
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverContainerId, setDragOverContainerId] = useState(undefined);
  const [dragPointerId, setDragPointerId] = useState(null);
  const [dragPointer, setDragPointer] = useState(null);
  const projectRef = useRef(project);
  const projectIndexRef = useRef(projectIndex);
  const selectedIdsRef = useRef(selectedIds);
  const onMoveToMenuRef = useRef(onMoveToMenu);
  const onSelectRef = useRef(onSelect);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onDragSelectRef = useRef(onDragSelect);
  const draggingIdRef = useRef(null);
  const dragOverContainerIdRef = useRef(undefined);
  const dragStartRef = useRef({ pointerId: null, entryId: null, startX: 0, startY: 0 });
  const dragPointerRef = useRef({ pointerId: null, x: 0, y: 0 });

  projectRef.current = project;
  projectIndexRef.current = projectIndex;
  selectedIdsRef.current = selectedIds;
  onMoveToMenuRef.current = onMoveToMenu;
  onSelectRef.current = onSelect;
  onSelectionChangeRef.current = onSelectionChange;
  onDragSelectRef.current = onDragSelect;

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
        const snapshot = projectRef.current;
        const snapshotIndex = projectIndexRef.current;
        const orderedCandidates = (currentSelectedIds?.has(activeId) && currentSelectedIds?.size > 1)
          ? snapshotIndex.flatEntries
            .map((flatEntry) => flatEntry.id)
            .filter((id) => currentSelectedIds.has(id))
          : [activeId];
        const getParentId = (id) => findParentMenuId(snapshot, id, snapshotIndex) ?? null;
        const idsToMove = buildTopLevelMovePlan(orderedCandidates, getParentId, (id) => (
          canMoveEntryToContainer(snapshot, snapshotIndex, id, targetContainerId)
        ));

        if (idsToMove.length > 0) {
          onMoveToMenuRef.current?.(idsToMove, null, targetContainerId);
          const nextSelectedId = snapshotIndex.entryById.has(activeId) ? activeId : idsToMove[0];
          onSelectRef.current?.(nextSelectedId);
        }
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

  const handleDragPointerDown = useCallback((event, entryId) => {
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
    const currentIds = selectedIdsRef.current;
    if (currentIds?.has(entryId) && currentIds?.size > 1) {
      onSelectionChangeRef.current?.(currentIds);
    }
    onDragSelectRef.current?.(entryId);
  }, []);

  return {
    draggingId,
    dragOverContainerId,
    dragPointer,
    handleDragPointerDown,
  };
}
