import { useCallback, useEffect, useReducer } from 'react';
import { CLOSED_MENU, menuReducer } from '../store/catalogue/menuState.js';
import { CLOSED_CHOICE, choiceReducer } from '../store/catalogue/exemplarChoice.js';

/**
 * Menu unique du catalogue (étiquette, carte, exemplaire) : ouverture près de
 * son déclencheur, navigation, fermeture et restitution du focus. Une action
 * de fiche à plusieurs cibles ouvre la boîte de choix d'exemplaire (D69), qui
 * rend elle aussi le focus à son déclencheur.
 */
export function useCatalogueMenus() {
  const [menu, dispatch] = useReducer(menuReducer, CLOSED_MENU);
  const [choice, dispatchChoice] = useReducer(choiceReducer, CLOSED_CHOICE);

  useEffect(() => {
    if (!choice.restoreFocusId) return;
    document.getElementById(choice.restoreFocusId)?.focus({ preventScroll: true });
    dispatchChoice({ type: 'focusRestored' });
  }, [choice.restoreFocusId]);

  useEffect(() => {
    if (!menu.restoreFocusId) return;
    document.getElementById(menu.restoreFocusId)?.focus({ preventScroll: true });
    dispatch({ type: 'focusRestored' });
  }, [menu.restoreFocusId]);

  useEffect(() => {
    if (!menu.open) return undefined;
    // Un clic hors du menu le ferme sans voler le focus de la cible cliquée.
    const outside = (event) => {
      if (!event.target.closest?.('[data-catalogue-menu]')) dispatch({ type: 'close', restoreFocus: false });
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [menu.open]);

  const open = useCallback(({ kind, targetId, scope = null, trigger, itemCount, point = null }) => {
    const rect = trigger?.getBoundingClientRect?.();
    const position = point ?? (rect ? { x: rect.left, y: rect.bottom } : null);
    dispatch({ type: 'open', kind, targetId, scope, returnFocusId: trigger?.id ?? null, itemCount, position });
  }, []);

  return {
    menu, dispatch, open, close: (restoreFocus = true) => dispatch({ type: 'close', restoreFocus }),
    choice, dispatchChoice,
  };
}
