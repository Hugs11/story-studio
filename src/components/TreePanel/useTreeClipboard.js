import { useState } from 'react';
import { deepCloneEntry } from '../../store/projectModel';
import { audioClipboard, imageClipboard } from '../../store/fieldClipboard';
import { useSharedClipboard } from '../../hooks/useSharedClipboard';
import { useMediaTransfer } from '../../store/MediaTransferContext';
import { pickAudio } from '../../hooks/useFileDialog';
import { filterTopLevelSelectedIds } from '../tree/treeOperations';
import { END_NODE_ID } from './treePanelConstants';

// Presse-papiers de l'arbre : copier/couper/coller d'entries (partagé avec le
// diagramme via useSharedClipboard), collage de médias et suppression de la
// sélection courante.
export function useTreeClipboard({
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
}) {
  const { dropOnNode } = useMediaTransfer();
  const clipboardRef = useSharedClipboard(); // { entries, isCut, sourceIds } — partagé avec le diagramme
  const [cutIds, setCutIds] = useState(new Set());

  function getTopLevelSelected() {
    const ids = [...selectedIds].filter((id) => id !== 'root' && id !== END_NODE_ID);
    return filterTopLevelSelectedIds(ids, getParentId);
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

  async function handleReplaceAudio(nodeId, nodeType) {
    const picked = await pickAudio();
    if (!picked) return;
    await dropOnNode({ nodeId, nodeType, path: picked, kind: 'audio' });
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

  async function deleteSelectedNodes() {
    const onlyEndNodeSelected = selectedIds.size === 1 && selectedIds.has(END_NODE_ID);
    if (onlyEndNodeSelected) {
      const removed = await onRemoveEndNode?.();
      if (removed === false) return;
      onSelectionChange?.(new Set(['root']));
      callOnSelect('root');
      return;
    }

    const toDelete = getTopLevelSelected();
    if (toDelete.length === 0) return;
    onBulkDeleteItems?.(toDelete);
    onSelectionChange?.(new Set(['root']));
    callOnSelect('root');
  }

  return {
    clipboardRef,
    cutIds,
    getTopLevelSelected,
    handleCopy,
    handleCut,
    handlePaste,
    handlePasteMedia,
    handleReplaceAudio,
    deleteSelectedNodes,
  };
}
