import { useCallback, useState } from 'react';
import { deepCloneEntry, findEntryById, findParentMenuId } from '../../../store/projectModel';
import { audioClipboard, imageClipboard } from '../../../store/fieldClipboard';
import { useSharedClipboard } from '../../../hooks/useSharedClipboard';
import { useMediaTransfer } from '../../../store/MediaTransferContext';
import { hasSelectedAncestor } from '../../tree/treeOperations';
import { END_NODE_ID } from '../flowDiagramLayout';

export function useDiagramClipboard({
  project,
  projectIndex,
  selectedId,
  selectedIds,
  onSelectionChange,
  onPasteEntries,
  onCutPasteEntries,
  onBulkDeleteItems,
  onRemoveEndNode,
  onSelectNode,
}) {
  const { dropOnNode } = useMediaTransfer();
  const clipboardRef = useSharedClipboard();
  const [cutIds, setCutIds] = useState(new Set());

  const getTopLevelSelected = useCallback((nodeId) => {
    const ids = (nodeId && !selectedIds?.has(nodeId))
      ? [nodeId]
      : [...(selectedIds ?? [])].filter((id) => id !== 'root' && id !== END_NODE_ID);
    const idSet = new Set(ids);
    const getParentId = (id) => findParentMenuId(project, id, projectIndex) ?? null;
    return ids.filter((id) => !hasSelectedAncestor(id, idSet, getParentId));
  }, [project, projectIndex, selectedIds]);

  const getPasteTargetId = useCallback((nodeId) => {
    if (!nodeId || nodeId === 'root') return null;
    const entry = findEntryById(project, nodeId, projectIndex);
    if (entry?.type === 'menu') return nodeId;
    return findParentMenuId(project, nodeId, projectIndex) ?? null;
  }, [project, projectIndex]);

  const handleCopy = useCallback((nodeId) => {
    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    clipboardRef.current = {
      entries: topLevel.map((id) => deepCloneEntry(findEntryById(project, id, projectIndex))).filter(Boolean),
      isCut: false,
      sourceIds: topLevel,
    };
    setCutIds(new Set());
  }, [clipboardRef, getTopLevelSelected, project, projectIndex]);

  const handleCut = useCallback((nodeId) => {
    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    clipboardRef.current = {
      entries: topLevel.map((id) => findEntryById(project, id, projectIndex)).filter(Boolean),
      isCut: true,
      sourceIds: topLevel,
    };
    setCutIds(new Set(topLevel));
  }, [clipboardRef, getTopLevelSelected, project, projectIndex]);

  const handlePaste = useCallback((nodeId) => {
    if (!clipboardRef.current?.entries?.length) return;
    const { entries, isCut, sourceIds } = clipboardRef.current;
    const targetId = getPasteTargetId(nodeId ?? (selectedIds?.size ? selectedId : null));
    if (isCut) {
      onCutPasteEntries?.(sourceIds, targetId);
      clipboardRef.current = null;
      setCutIds(new Set());
    } else {
      onPasteEntries?.(targetId, entries.map((entry) => deepCloneEntry(entry)));
    }
  }, [clipboardRef, getPasteTargetId, onCutPasteEntries, onPasteEntries, selectedId, selectedIds]);

  const handlePasteMedia = useCallback((nodeId, nodeType, kind) => {
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
  }, [dropOnNode]);

  const handleDeleteSelection = useCallback(async (nodeId) => {
    const onlyEndNodeSelected = selectedIds?.size === 1 && selectedIds?.has(END_NODE_ID);
    if (nodeId === END_NODE_ID && onlyEndNodeSelected) {
      const removed = await onRemoveEndNode?.();
      if (removed === false) return;
      onSelectionChange?.(new Set(['root']));
      onSelectNode?.('root');
      return;
    }

    const topLevel = getTopLevelSelected(nodeId);
    if (!topLevel.length) return;
    onBulkDeleteItems?.(topLevel);
    onSelectionChange?.(new Set(['root']));
    onSelectNode?.('root');
  }, [getTopLevelSelected, onBulkDeleteItems, onRemoveEndNode, onSelectNode, onSelectionChange, selectedIds]);

  return {
    clipboardRef,
    cutIds,
    getTopLevelSelected,
    getPasteTargetId,
    handleCopy,
    handleCut,
    handlePaste,
    handlePasteMedia,
    handleDeleteSelection,
  };
}
