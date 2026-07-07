// Logique pure de multi-selection du diagramme (Ctrl/Cmd/Shift-clic). Extraite
// de FullDiagramNode pour etre testable et garantir l'invariant partage avec
// l'arbre : la selection n'est jamais vide et l'`id` actif renvoye appartient
// toujours a `next`. Le diagramme n'a pas de range (pas de liste plate) : Shift
// s'y comporte comme Ctrl (toggle). END_NODE_ID ne participe pas a la multi.

// Sentinelle partagee avec l'arbre (meme valeur que flowDiagramLayout) ; importee
// depuis les constantes de l'arbre pour rester testable sous `node --test`.
import { END_NODE_ID } from '../../TreePanel/treePanelConstants.js';

export function toggleDiagramSelection({ id, selectedIds, selectedId }) {
  const next = new Set([...(selectedIds ?? [selectedId])].filter((sid) => sid !== END_NODE_ID));
  let nextSelectedId;

  if (next.has(id)) {
    next.delete(id);
    // Jamais de selection vide : si le noeud clique etait le seul, on le garde.
    if (next.size === 0) next.add(id);
  } else {
    next.add(id);
    nextSelectedId = id;
  }

  if (nextSelectedId === undefined) {
    // Toggle-off : garder l'element actif s'il est encore selectionne, sinon
    // basculer sur le dernier encore present (ordre de selection).
    nextSelectedId = next.has(selectedId) ? selectedId : [...next].at(-1);
  }

  return { next, nextSelectedId };
}
