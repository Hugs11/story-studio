// Rendu minimal d'un nœud `ref` dans l'arbre (Étape 2f).
//
// Une `ref` est un pointeur pur : elle n'a pas de nom propre, son libellé est dérivé
// de sa cible. On résout l'id d'entrée ciblé via l'encodage navigation existant, puis
// on affiche « ↪ <nom cible> » (ou « ↩ … » pour un retour). Aucune ligne d'arbre n'est
// ajoutée pour une ref hébergée (badge) — ce helper ne sert qu'aux refs rendues en feuille.

import { refTargetEntryId } from '../../store/navigationTargets.js';

export { refTargetEntryId };

// { targetId, label, isReturn } pour afficher une ref en feuille d'arbre.
// `entryById` : Map id → entrée (pour résoudre le nom de la cible).
export function buildRefDisplay(entry, entryById = new Map()) {
  const targetId = refTargetEntryId(entry?.target);
  const explicit = typeof entry?.label === 'string' ? entry.label.trim() : '';
  const targetName = targetId ? (entryById.get(targetId)?.name ?? '').trim() : '';
  const name = explicit || targetName || 'cible inconnue';
  const isReturn = entry?.refKind === 'return';
  return { targetId, label: `${isReturn ? '↩' : '↪'} ${name}`, isReturn };
}
