// La position du panneau Réglages, retenue pour les derniers nœuds visités.
//
// L'auteur va de lien en lien — un Écran, la liste qu'il ouvre, un Écran de
// cette liste — puis revient : il retrouve le panneau où il l'avait laissé,
// sans défiler de nouveau jusqu'à l'encadré qu'il lisait. Seuls les
// SCROLL_MEMORY_SIZE derniers nœuds sont retenus, en mémoire seulement : rien
// n'est enregistré, et un nœud oublié s'ouvre en haut, comme avant.

import { useLayoutEffect, useRef } from 'react';

export const SCROLL_MEMORY_SIZE = 10;

// Retient `top` pour `key` en le plaçant le plus récent, et oublie les plus
// anciens au-delà de `limit`. La `Map` garde l'ordre d'insertion : la retirer
// avant de la remettre suffit à la rafraîchir.
export function rememberScroll(memory, key, top, limit = SCROLL_MEMORY_SIZE) {
  memory.delete(key);
  memory.set(key, top);
  while (memory.size > limit) memory.delete(memory.keys().next().value);
  return memory;
}

// `key` désigne le nœud affiché (null : aucun). Renvoie le gestionnaire à
// poser sur `onScroll` du conteneur qui défile.
export function useInspectorScrollMemory(containerRef, key) {
  const memory = useRef(new Map());
  const currentKey = useRef(key);

  // Avant peinture : le panneau s'affiche directement à la bonne hauteur. Le
  // défilement que le navigateur signale ensuite (hauteur changée par le
  // nouveau contenu) est lu avec la nouvelle clé, donc sans rien écraser.
  useLayoutEffect(() => {
    currentKey.current = key;
    const container = containerRef.current;
    if (!container || key === null) return;
    container.scrollTop = memory.current.get(key) ?? 0;
  }, [containerRef, key]);

  return (event) => {
    const key = currentKey.current;
    if (key === null) return;
    rememberScroll(memory.current, key, event.currentTarget.scrollTop);
  };
}
