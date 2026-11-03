import { useCallback } from 'react';
import { clipboardText } from '../store/catalogue/clipboardText.js';
import { menuRevealRequest } from '../store/catalogue/browserState.js';
import { revealLine } from '../store/catalogue/cardActions.js';

/**
 * Actions immédiates du catalogue : afficher dans l'explorateur (commande du
 * moteur, cible revalidée) et copier dans le presse-papiers. Seul un repli est
 * annoncé ; une erreur est remise à l'écran, jamais avalée.
 */
export function useCatalogueActions({ api, onAnnounce, onError }) {
  const reveal = useCallback(async (target, exemplar) => {
    try {
      const result = await api.revealExemplar(menuRevealRequest(target, exemplar));
      if (result.fallbackParentOpened) onAnnounce(revealLine(result, exemplar.path));
    } catch (error) { onError(error); }
  }, [api, onAnnounce, onError]);

  const copy = useCallback(async (command, card, exemplar = null) => {
    const target = clipboardText(command, card, exemplar);
    if (!target.enabled) return;
    try {
      await navigator.clipboard.writeText(target.text);
      return true;
    } catch (error) { onError(error); return false; }
  }, [onError]);

  return { reveal, copy };
}
