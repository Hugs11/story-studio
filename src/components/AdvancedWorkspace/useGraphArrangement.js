// Le rangement du graphe : un seul état pour le bouton et pour le clavier.
//
// Il vivait dans le bouton de la colonne. Le raccourci ne pouvait donc ni
// savoir qu'un rangement était déjà en cours, ni dire qu'il avait été refusé :
// deux chemins vers le même geste, dont un muet. Il vit ici, une fois, et la
// colonne comme le clavier en lisent le même état.
//
// Un rangement se comporte comme un déplacement à la main : il écrit la
// position d'auteur tout de suite, et `Ctrl+Z` le défait. Un rangement
// calculé ne devient authored que si l'auteur l'applique explicitement ; le clic
// ou la touche sont cet acte.

import { useCallback, useMemo, useRef, useState } from 'react';

import { NO_FOLD, parcoursLayout } from '../../store/advancedGraphView/graphParcoursLayout.js';

export const ARRANGEMENT_REFUSED = 'Le rangement a été refusé : rien n’a été modifié.';

export function useGraphArrangement({ index, applyLayout, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  // Le verrou est une ref : deux appuis dans le même tour de boucle ne doivent
  // pas lancer deux rangements, et l'état de React ne serait lu qu'au rendu.
  const running = useRef(false);

  const arrange = useCallback(async (fold = NO_FOLD) => {
    if (!index || !applyLayout || disabled || running.current) return false;
    running.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { positions } = parcoursLayout(index, fold);
      if (positions.size === 0) return false;
      const entries = [...positions].map(([path, position]) => ({ path, ...position }));
      const accepted = await applyLayout(entries);
      // Un refus laisse le document intact. Le canvas n'a rien à restaurer —
      // il n'a rien peint — mais le dire vaut mieux qu'une commande sans effet.
      if (!accepted) setFailure(ARRANGEMENT_REFUSED);
      return accepted === true;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [applyLayout, disabled, index]);

  const unavailable = disabled || !index || !applyLayout;
  return useMemo(() => ({
    busy, failure, disabled: unavailable, arrange,
  }), [arrange, busy, failure, unavailable]);
}
