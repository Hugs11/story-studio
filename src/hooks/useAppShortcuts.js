import { useEffect } from 'react';
import { isEditableTarget } from '../utils/shortcutTarget';
import { findShortcutAction } from '../store/keyboardShortcuts';
import { isModalSurfaceOpen } from '../utils/modalSurfaces';
import { runShortcutCommand } from '../store/shortcutCommands';
import { commandKeyIsMeta } from '../utils/platformKeys';

export function useAppShortcuts({ actionsRef, keyboardShortcutsRef, saveHandlerRef, saveAsHandlerRef }) {
  useEffect(() => {
    function handleKeyDown(e) {
      // La commande est Ctrl, ou Cmd sous macOS : la recherche native de la
      // WebView s'y ouvre aussi.
      const commandIsMeta = commandKeyIsMeta();
      const shouldBlockNativeFind = (e.ctrlKey || (commandIsMeta && e.metaKey))
        && !e.shiftKey
        && !e.altKey
        && (commandIsMeta || !e.metaKey)
        && (e.code === 'KeyF' || e.code === 'KeyG');
      const stopShortcut = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
      };
      // Sous une modale : aucun raccourci global. On neutralise seulement l'UI
      // de recherche native (preventDefault) sans stopper la propagation, pour
      // que les gestionnaires locaux de la modale reçoivent la touche (p. ex.
      // enregistrer Ctrl+F comme raccourci dans la modale dédiée).
      if (isModalSurfaceOpen()) {
        if (shouldBlockNativeFind) e.preventDefault();
        return;
      }

      if (shouldBlockNativeFind) stopShortcut();

      const actions = actionsRef.current;
      // Les commandes communes aux deux éditeurs, et celles du Libre : une
      // commande que l'éditeur courant n'offre pas est indisponible dans
      // l'inventaire de la barre, et ne répond donc pas.
      const actionId = findShortcutAction(e, keyboardShortcutsRef.current, ['general', 'libre']);
      if (!actionId) return;

      if (actionId === 'saveAs') {
        stopShortcut();
        saveAsHandlerRef.current?.();
        return;
      }

      if (actionId === 'saveProject') {
        stopShortcut();
        saveHandlerRef.current?.();
        return;
      }

      // Annuler et Rétablir ne prennent jamais la main sur une saisie en
      // cours : c'est l'annulation du champ que l'auteur attend.
      if ((actionId === 'undo' || actionId === 'redo') && isEditableTarget(e.target)) return;

      if (actionId === 'treeSearch') {
        stopShortcut();
        if (!actions.treeSearchVisible) return;
        actions.focusTreeSearch?.();
        return;
      }

      // Toutes les autres passent par la table, qui consulte la disponibilité
      // de l'inventaire de la barre. Bouton et clavier ne peuvent donc pas
      // dire deux choses différentes.
      if (runShortcutCommand(actionId, actions) === 'ran') stopShortcut();
    }
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);
}
