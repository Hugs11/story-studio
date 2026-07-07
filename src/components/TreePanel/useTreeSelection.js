// Hook : gere la selection multiple du TreePanel (single click, ctrl+click,
// shift+click range via flatNodes, END_NODE_ID, root). La selection `selectedIds`
// est CONTROLEE par l'hote (passee en prop) : le hook ne la stocke plus, il
// calcule le prochain etat et l'emet via `onSelectionChange`. Extrait de
// TreePanel.jsx.

import { useCallback, useEffect, useRef } from 'react';

import { END_NODE_ID } from './treePanelConstants.js';

export function toggleTreeSelection({ id, selectedIds, selectedId }) {
  const next = new Set(selectedIds);
  let nextSelectedId = null;
  let nextAnchorId = null;

  if (next.has(id)) {
    next.delete(id);
    if (next.size === 0) {
      next.add(id);
      nextSelectedId = id;
    } else if (id === selectedId) {
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
  selectedIds,
  selectedId,
  onSelect,
  onSelectionChange,
  flatNodes,
  flatNodeIndexById,
}) {
  const anchorIdRef = useRef(selectedId);
  // Miroir ref de la selection controlee : lu par l'effet de recalage d'ancre
  // sans devoir en dependre (motif state+ref du projet).
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;

  const callOnSelect = useCallback((id) => {
    onSelect(id);
  }, [onSelect]);

  // L'hote est la source de verite de `selectedIds` ; le hook ne resynchronise
  // plus. On garde seulement l'ancre du shift-range coherente : si une selection
  // venue de l'exterieur (diagramme, simulateur, pastille...) ne contient plus
  // l'ancre courante, on la recale sur l'element actif.
  useEffect(() => {
    if (!selectedIdsRef.current.has(anchorIdRef.current)) {
      anchorIdRef.current = selectedId;
    }
  }, [selectedId, selectedIds]);

  const handleNodeSelect = useCallback((id, e) => {
    const isCtrl = e?.ctrlKey || e?.metaKey;
    const isShift = e?.shiftKey;

    if (id === END_NODE_ID && !isCtrl && !isShift) {
      anchorIdRef.current = END_NODE_ID;
      onSelectionChange?.(new Set([END_NODE_ID]));
      callOnSelect(END_NODE_ID);
      return;
    }

    if (isCtrl && !isShift) {
      const { next, nextSelectedId, nextAnchorId } = toggleTreeSelection({ id, selectedIds, selectedId });
      if (nextAnchorId) anchorIdRef.current = nextAnchorId;
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
        anchorIdRef.current = id;
        onSelectionChange?.(new Set([id]));
        callOnSelect(id);
        return;
      }
      onSelectionChange?.(next);
      callOnSelect(id);
    } else {
      anchorIdRef.current = id;
      onSelectionChange?.(new Set([id]));
      callOnSelect(id);
    }
  }, [callOnSelect, flatNodeIndexById, flatNodes, onSelectionChange, selectedId, selectedIds]);

  return {
    anchorIdRef,
    callOnSelect,
    handleNodeSelect,
  };
}
