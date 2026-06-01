// Helpers de "focus" du FullDiagramTree : isolent la branche pertinente du
// projet pour l'afficher en plein ecran sans le reste de l'arbre. Extraits
// pour reduire la surface de FullDiagramTree.jsx et permettre un test futur.

import { findEntryPath } from '../../store/projectModel';
import { countDescendants } from '../tree/treeOperations.js';

function summarizeEntryList(children) {
  return {
    total: children.length,
    stories: children.filter((child) => child.type === 'story').length,
    containers: children.filter((child) => child.type === 'menu' || child.type === 'zip').length,
    descendants: children.reduce((count, child) => count + 1 + countDescendants(child), 0),
  };
}

function summarizeChildren(entry) {
  const children = entry?.type === 'menu' ? (entry.children ?? []) : [];
  return summarizeEntryList(children);
}

export function buildChildSummaryMap(entries, map = new Map(), includeRoot = true) {
  if (includeRoot) map.set('root', summarizeEntryList(entries ?? []));
  for (const entry of entries ?? []) {
    if (entry.type === 'menu') {
      map.set(entry.id, summarizeChildren(entry));
      buildChildSummaryMap(entry.children ?? [], map, false);
    }
  }
  return map;
}

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
