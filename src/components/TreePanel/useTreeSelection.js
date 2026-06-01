// Hook : gere la selection multiple du TreePanel (single click, ctrl+click,
// shift+click range via flatNodes, END_NODE_ID, root) et la synchro avec la
// selection externe `selectedId`. Extrait de TreePanel.jsx.

import { useCallback, useEffect, useRef, useState } from 'react';

import { END_NODE_ID } from './treePanelConstants.js';

export function toggleTreeSelection({ id, selectedIds, selectedId }) {
  const next = new Set(selectedIds);
  let nextSelectedId = null;
  let nextAnchorId = null;

  if (next.has(id)) {
    next.delete(id);
    if (next.size === 0) next.add(id);
    if (id === selectedId) {
      nextSelectedId = [...next].find((currentId) => currentId !== id) ?? 'root';
    }
  } else {
    next.add(id);
    nextAnchorId = id;
    nextSelectedId = id;
  }

  return { next, nextSelectedId, nextAnchorId };
}

export function rangeTreeSelection({
  id,
  anchorId,
  selectedIds,
  flatNodes,
  flatNodeIndexById,
  additive = false,
}) {
  const anchorIdx = flatNodeIndexById.get(anchorId) ?? -1;
  const currentIdx = flatNodeIndexById.get(id) ?? -1;
  if (anchorIdx === -1 || currentIdx === -1) return null;

  const [start, end] = anchorIdx <= currentIdx ? [anchorIdx, currentIdx] : [currentIdx, anchorIdx];
  const next = additive
    ? new Set(selectedIds)
    : new Set();
  for (let i = start; i <= end; i += 1) {
    next.add(flatNodes[i].id);
  }
  next.add(anchorId);
  if (next.size === 0) next.add(id);
  return next;
}

export function useTreeSelection({
  selectedId,
  onSelect,
  onSelectionChange,
  flatNodes,
  flatNodeIndexById,
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set([selectedId]));
  const anchorIdRef = useRef(selectedId);
  const skipSyncRef = useRef(false);
  const prevSelectedIdRef = useRef(selectedId);

  const callOnSelect = useCallback((id) => {
    skipSyncRef.current = true;
    onSelect(id);
  }, [onSelect]);

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

  const handleNodeSelect = useCallback((id, e) => {
    const isCtrl = e?.ctrlKey || e?.metaKey;
    const isShift = e?.shiftKey;

    if (id === END_NODE_ID && !isCtrl && !isShift) {
      const single = new Set([END_NODE_ID]);
      setSelectedIds(single);
      onSelectionChange?.(single);
      anchorIdRef.current = END_NODE_ID;
      callOnSelect(END_NODE_ID);
      return;
    }

    if (isCtrl && !isShift) {
      const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({ id, selectedIds, selectedId });
      if (nextAnchorId) anchorIdRef.current = nextAnchorId;
      setSelectedIds(next);
      onSelectionChange?.(next);
      if (nextSelectedId) callOnSelect(nextSelectedId);
    } else if (isShift && anchorIdRef.current) {
      const next = rangeTreeSelection({
        id,
        anchorId: anchorIdRef.current,
        selectedIds,
        flatNodes,
        flatNodeIndexById,
        additive: isCtrl,
      });
      if (!next) {
        callOnSelect(id);
        const single = new Set([id]);
        setSelectedIds(single);
        onSelectionChange?.(single);
        return;
      }
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
  }, [callOnSelect, flatNodeIndexById, flatNodes, onSelectionChange, selectedId, selectedIds]);

  return {
    selectedIds,
    setSelectedIds,
    anchorIdRef,
    callOnSelect,
    handleNodeSelect,
  };
}
