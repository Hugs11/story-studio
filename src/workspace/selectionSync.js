export function getPendingInternalSelectedId({
  currentSelectedId,
  nextSelectedId,
}) {
  if (!nextSelectedId || nextSelectedId === currentSelectedId) return null;
  return nextSelectedId;
}

export function buildSimulatorSelectionSync(activeNodeId, requestId) {
  if (!activeNodeId || !requestId) return null;
  return {
    selectedIds: new Set([activeNodeId]),
    revealRequest: { id: activeNodeId, requestId },
  };
}

export function resolveWorkspaceSelectionSync({
  selectedId,
  selectedIds,
  pendingInternalSelectedId,
}) {
  const preserveSelection = pendingInternalSelectedId === selectedId
    && selectedIds?.size > 0
    && selectedIds.has(selectedId);

  return {
    selectedIds: preserveSelection ? selectedIds : new Set([selectedId]),
    pendingInternalSelectedId: null,
    preserveSelection,
  };
}
