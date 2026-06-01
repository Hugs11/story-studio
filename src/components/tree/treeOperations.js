import { findEntryById, findParentMenuId } from '../../store/projectModel/index.js';

// Palette de couleurs assignees aux racines (utilisee par TreePanel et FullDiagramTree).
export const TREE_COLOR_PALETTE = ['#e24b4a', '#ef9f27', '#f0c84b', '#5fbf6b', '#3d9be9', '#7c6af7', '#d95bb4'];

// Vrai si entryId a un ancetre dans le set candidateIds (selection multiple).
// getParentId(entryId) retourne l'id parent ou null.
export function hasSelectedAncestor(entryId, candidateIds, getParentId) {
  let parentId = getParentId(entryId);
  while (parentId != null) {
    if (candidateIds.has(parentId)) return true;
    parentId = getParentId(parentId);
  }
  return false;
}

// Compte recursif des descendants d'une entree (menu ou autre). Une feuille -> 0.
export function countDescendants(entry) {
  if (entry?.type !== 'menu') return 0;
  return (entry.children ?? []).reduce((count, child) => (
    count + 1 + countDescendants(child)
  ), 0);
}

export function containsMenu(entry, targetMenuId) {
  if (!entry || entry.type !== 'menu') return false;
  if (entry.id === targetMenuId) return true;
  return (entry.children ?? []).some((child) => containsMenu(child, targetMenuId));
}

export function wouldCreateMenuCycle(entry, targetContainerId, projectIndex = null) {
  if (targetContainerId == null || entry?.type !== 'menu') return false;
  const targetPath = projectIndex?.pathById.get(targetContainerId) ?? null;
  if (targetPath) {
    return targetPath.some((ancestor) => ancestor.id === entry.id);
  }
  return containsMenu(entry, targetContainerId);
}

export function canMoveEntryToContainer(project, projectIndex, entryId, targetContainerId) {
  if (!entryId || entryId === 'root') return false;
  const entry = findEntryById(project, entryId, projectIndex);
  if (!entry) return false;
  const sourceContainerId = findParentMenuId(project, entryId, projectIndex);
  if (sourceContainerId === targetContainerId) return false;
  if (wouldCreateMenuCycle(entry, targetContainerId, projectIndex)) return false;
  return targetContainerId == null || !!findEntryById(project, targetContainerId, projectIndex);
}

// Resoud la zone de drop "pertinente" pour un node donne a partir du dropInfo
// global du DnD. Retourne 'before' | 'after' | 'inside' | null.
//
// IMPORTANT (perf) : cette fn permet de passer une string courte a chaque
// TreeNode au lieu de l'objet dropInfo complet. Sans ca, le comparateur memo
// `prev.dropInfo === next.dropInfo` invaliderait TOUS les nodes a chaque
// mousemove du drag (60 changements/s), provoquant N re-renders/frame.
// Avec une string, 99% des nodes voient null === null et restent stables.
export function resolveDropTargetForNode(id, type, dropInfo) {
  if (!dropInfo) return null;
  const isMyTarget = dropInfo.targetId === id
    || (type === 'root' && dropInfo.targetId === null && dropInfo.isContainer);
  if (!isMyTarget) return null;
  if (dropInfo.position === 'before' && !dropInfo.isContainer) return 'before';
  if (dropInfo.position === 'after' && !dropInfo.isContainer) return 'after';
  if (dropInfo.position === 'inside'
    && (dropInfo.isContainer || type === 'menu' || type === 'root')) {
    return 'inside';
  }
  return null;
}

// Resoud le container cible d'un drop : container explicite, root, ou parent
// d'un entry survole. Utilise par TreePanel pour la gestion DnD.
export function resolveDropContainerId(over, overData, overEntry, isContainerDrop, getParentId) {
  if (isContainerDrop) {
    if (overData && Object.prototype.hasOwnProperty.call(overData, 'containerId')) {
      return overData.containerId;
    }
    return over.id === 'container:root' ? null : String(over.id).replace(/^container:/, '');
  }
  if (over.id === 'root') return null;
  return overEntry?.type === 'menu' ? overEntry.id : getParentId(over.id);
}
