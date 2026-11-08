import { useEffect, useRef } from 'react';
import { findShortcutAction, getCurrentShortcuts } from '../store/keyboardShortcuts.js';
import { catalogueShortcutsEnabled } from '../store/catalogue/browserState.js';
import { isEditableTarget } from '../utils/shortcutTarget.js';

/**
 * Raccourcis de la portée `catalogue` (rechercher, tout sélectionner, vider la
 * sélection, annuler), actifs dans l’écran Catalogue. Un menu ou une
 * fenêtre ouverte garde ses propres touches ; une saisie garde Ctrl+A, Ctrl+Z et Échap.
 * @param {{search: Function, selectAll: Function, clear: Function, blocked: () => boolean}} handlers
 */
export function useCatalogueShortcuts(handlers, { active = true } = {}) {
  const current = useRef(handlers);
  current.current = { ...handlers, active };
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.target?.closest?.('[role="dialog"], [role="menu"], dialog')) return;
      const actionId = findShortcutAction(event, getCurrentShortcuts(), 'catalogue');
      if (!actionId || !catalogueShortcutsEnabled(current.current.active, current.current.blocked())) return;
      if (actionId === 'catalogueSearch') {
        // La capture globale peut avoir neutralisé la recherche native de la
        // WebView. La recherche de cette portée reste disponible, même en saisie.
        event.preventDefault();
        current.current.search();
        return;
      }
      if (event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      if (actionId === 'catalogueSelectAll') {
        event.preventDefault();
        current.current.selectAll();
      } else if (actionId === 'catalogueUndo') {
        event.preventDefault();
        void current.current.undo?.();
      } else if (actionId === 'catalogueClearSelection' && current.current.clear()) {
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
