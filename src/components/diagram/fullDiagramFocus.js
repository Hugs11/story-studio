// Helpers de "focus" du FullDiagramTree : isolent la branche pertinente du
// projet pour l'afficher en plein ecran sans le reste de l'arbre. Extraits
// pour reduire la surface de FullDiagramTree.jsx et permettre un test futur.

import { findEntryPath } from '../../store/projectModel';

function cloneFocusedPath(path, index = 0) {
  const entry = path[index];
  if (!entry) return null;
  if (index >= path.length - 1) {
    return entry.type === 'menu'
      ? { ...entry, children: entry.children ?? [] }
      : { ...entry };
  }
  const focusedChild = cloneFocusedPath(path, index + 1);
  return {
    ...entry,
    children: focusedChild ? [focusedChild] : [],
  };
}

// Reduit le projet a l'unique branche menant a selectedId, pour focus du diagramme.
// Si pas de selection ou selection sur root/endNode, retourne le projet inchange.
export function buildFocusProject(project, selectedId, endNodeId, projectIndex) {
  if (!selectedId || selectedId === 'root' || selectedId === endNodeId) return project;
  const path = findEntryPath(project, selectedId, projectIndex) ?? [];
  if (!path.length) return project;
  const focusedEntry = cloneFocusedPath(path);
  if (!focusedEntry) return project;
  return {
    ...project,
    rootEntries: [focusedEntry],
  };
}
