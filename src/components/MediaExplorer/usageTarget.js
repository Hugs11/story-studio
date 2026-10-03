// Un usage d'arbre porte un `entryId`, un usage de graphe un `nodePath`. Les
// entrées « Voir l'utilisation dans le projet » (fiche et menu contextuel) vont
// toutes deux au premier usage localisable ; sans gestionnaire pour sa nature,
// l'entrée n'est pas proposée.
export function resolveUsageTarget(item, { onSelectNode, onRevealGraphNode }) {
  if (item?.kind !== 'audio') return null;
  const usage = (item.usages ?? []).find((u) => u.entryId || u.nodePath) ?? null;
  if (usage?.entryId && onSelectNode) {
    return { label: usage.label, go: () => onSelectNode(usage.entryId) };
  }
  if (usage?.nodePath && onRevealGraphNode) {
    return { label: usage.label, go: () => onRevealGraphNode(usage.nodePath) };
  }
  return null;
}
