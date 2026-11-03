// État du menu du catalogue (menu contextuel d'une carte, actions d'un exemplaire). Un seul menu ouvert à la fois ; ouvrir
// un menu remplace le précédent. Les éléments désactivés restent atteignables
// (ils portent leur raison). La fermeture indique l'élément qui reprend le
// focus.
//
// Un menu peut empiler une étape : le choix de l'exemplaire visé par une
// action de fiche lorsqu'il y en a plusieurs.

export const CLOSED_MENU = Object.freeze({
  open: false,
  kind: null,
  targetId: null,
  scope: null,
  returnFocusId: null,
  activeIndex: 0,
  itemCount: 0,
  step: null,
  position: null,
  restoreFocusId: null,
});

function wrap(index, count) {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

/**
 * @param {typeof CLOSED_MENU} state
 * @param {{type: 'open', kind: string, targetId: string, scope?: string, returnFocusId: string,
 *   itemCount: number, position?: {x: number, y: number}}
 *   | {type: 'move', delta: number} | {type: 'first'} | {type: 'last'} | {type: 'focus', index: number}
 *   | {type: 'choose', action: string, itemCount: number} | {type: 'back', itemCount: number}
 *   | {type: 'setCount', itemCount: number} | {type: 'close', restoreFocus?: boolean}
 *   | {type: 'focusRestored'}} action
 */
export function menuReducer(state = CLOSED_MENU, action) {
  switch (action.type) {
    case 'open':
      return {
        ...CLOSED_MENU,
        open: true,
        kind: action.kind,
        targetId: action.targetId,
        scope: action.scope ?? null,
        returnFocusId: action.returnFocusId ?? null,
        itemCount: Math.max(0, action.itemCount ?? 0),
        position: action.position ?? null,
      };
    case 'move':
      return state.open ? { ...state, activeIndex: wrap(state.activeIndex + action.delta, state.itemCount) } : state;
    case 'first':
      return state.open ? { ...state, activeIndex: 0 } : state;
    case 'last':
      return state.open ? { ...state, activeIndex: Math.max(0, state.itemCount - 1) } : state;
    case 'focus':
      return state.open ? { ...state, activeIndex: wrap(action.index, state.itemCount) } : state;
    case 'setCount':
      return state.open ? { ...state, itemCount: action.itemCount, activeIndex: Math.min(state.activeIndex, Math.max(0, action.itemCount - 1)) } : state;
    case 'choose':
      return state.open ? { ...state, step: { action: action.action, returnIndex: state.activeIndex }, itemCount: action.itemCount, activeIndex: 0 } : state;
    case 'back':
      return state.open && state.step
        ? { ...state, activeIndex: state.step.returnIndex, step: null, itemCount: action.itemCount }
        : state;
    case 'close':
      if (!state.open) return state;
      return { ...CLOSED_MENU, restoreFocusId: action.restoreFocus === false ? null : state.returnFocusId };
    case 'focusRestored':
      return state.restoreFocusId === null ? state : { ...state, restoreFocusId: null };
    default:
      return state;
  }
}

/**
 * Action correspondant à une touche dans un menu ouvert, ou `null`.
 * Entrée et Espace activent l'élément actif (géré par l'appelant : `activate`).
 */
export function menuKeyAction(state, key) {
  if (!state.open) return null;
  switch (key) {
    case 'ArrowDown': return { type: 'move', delta: 1 };
    case 'ArrowUp': return { type: 'move', delta: -1 };
    case 'Home': return { type: 'first' };
    case 'End': return { type: 'last' };
    case 'Escape': return { type: 'close' };
    // Tab ferme le menu et revient au déclencheur ; le Tab suivant poursuit le parcours.
    case 'Tab': return { type: 'close' };
    case 'ArrowLeft': return state.step ? { type: 'back' } : null;
    case 'Enter':
    case ' ': return { type: 'activate' };
    default: return null;
  }
}
