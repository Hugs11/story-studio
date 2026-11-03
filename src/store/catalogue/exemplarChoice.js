// Choix de l'exemplaire visé par une action de fiche (D69).
//
// Deux politiques :
// - « Simuler » demande l’exemplaire lorsque plusieurs exemplaires existent ;
// - « Modifier » demande **toujours** dès qu'il existe plusieurs exemplaires
//   ou formats.
// Les exemplaires incompatibles ou indisponibles restent présents dans la
// liste, désactivés avec leur raison. L'ordre est celui des exemplaires de la
// fiche (formats dans l'ordre fixe, puis du plus récent au plus ancien).
//
// La boîte de choix suit les actualisations : la liste est recalculée depuis
// la fiche courante, la cible gardée par identifiant d'exemplaire et la
// révision mise à jour ; un exemplaire disparu n'est jamais remplacé par un
// autre. Le moteur revalide encore la cible au clic.

export const CHOICE_POLICIES = Object.freeze({
  simulate: 'whenSeveralCopies',
  edit: 'always',
});

const NO_EXEMPLAR = 'catalogue:actions.reason.noExemplar';
const NO_SUITABLE = 'catalogue:reason.action.noSuitableExemplar';

/** Éléments de la liste : chaque exemplaire, activé ou désactivé avec sa raison. */
export function choiceItems(exemplars, availability) {
  return (Array.isArray(exemplars) ? exemplars : []).map((exemplar) => {
    const state = availability(exemplar);
    return { id: exemplar.id, exemplar, enabled: state.enabled === true, reasonKey: state.enabled ? null : state.reasonKey ?? null, reasonParams: state.enabled ? undefined : state.reasonParams };
  });
}

/**
 * Ce que fait l'action : rien (raison), lancement direct, ou choix.
 * @returns {{kind: 'unavailable', reasonKey: string} | {kind: 'direct', exemplarId: string}
 *   | {kind: 'choose', items: Array}}
 */
export function choiceDecision(exemplars, { policy, availability }) {
  const items = choiceItems(exemplars, availability);
  const suitable = items.filter((item) => item.enabled);
  if (!items.length) return { kind: 'unavailable', reasonKey: NO_EXEMPLAR };
  if (policy === 'always') {
    if (items.length > 1) return { kind: 'choose', items };
    return items[0].enabled
      ? { kind: 'direct', exemplarId: items[0].id }
      : { kind: 'unavailable', reasonKey: items[0].reasonKey };
  }
  if (!suitable.length) {
    return { kind: 'unavailable', reasonKey: items.length === 1 ? items[0].reasonKey : NO_SUITABLE };
  }
  if (policy === 'whenSeveralCopies' && items.length > 1) return { kind: 'choose', items };
  if (suitable.length === 1) return { kind: 'direct', exemplarId: suitable[0].id };
  return { kind: 'choose', items };
}

export const CLOSED_CHOICE = Object.freeze({
  open: false,
  cardId: null,
  command: null,
  revision: null,
  activeIndex: 0,
  itemCount: 0,
  returnFocusId: null,
  restoreFocusId: null,
});

function wrap(index, count) {
  if (count <= 0) return 0;
  return ((index % count) + count) % count;
}

function firstEnabled(items) {
  const index = items.findIndex((item) => item.enabled);
  return index < 0 ? 0 : index;
}

/**
 * État de la boîte de choix.
 * - `open` : `{cardId, command, revision, items, returnFocusId}` ;
 * - `refresh` : `{items, revision, activeId}` après une actualisation (la
 *   ligne active est retrouvée par identifiant, sinon ramenée en tête) ;
 * - `move` / `first` / `last` / `focus` : navigation (les éléments désactivés
 *   restent atteignables, ils portent leur raison) ;
 * - `close` : fermeture, focus rendu au déclencheur.
 */
export function choiceReducer(state = CLOSED_CHOICE, action) {
  switch (action.type) {
    case 'open':
      return {
        ...CLOSED_CHOICE,
        open: true,
        cardId: action.cardId,
        command: action.command,
        revision: action.revision ?? null,
        itemCount: action.items.length,
        activeIndex: action.items.some(item => item.id === action.referenceExemplarId) ? action.items.findIndex(item => item.id === action.referenceExemplarId) : firstEnabled(action.items),
        returnFocusId: action.returnFocusId ?? null,
      };
    case 'refresh': {
      if (!state.open) return state;
      if (!action.items.length) return { ...CLOSED_CHOICE, restoreFocusId: state.returnFocusId };
      const kept = action.items.findIndex((item) => item.id === action.activeId);
      return {
        ...state,
        revision: action.revision ?? state.revision,
        itemCount: action.items.length,
        activeIndex: kept >= 0 ? kept : firstEnabled(action.items),
      };
    }
    case 'move':
      return state.open ? { ...state, activeIndex: wrap(state.activeIndex + action.delta, state.itemCount) } : state;
    case 'first':
      return state.open ? { ...state, activeIndex: 0 } : state;
    case 'last':
      return state.open ? { ...state, activeIndex: Math.max(0, state.itemCount - 1) } : state;
    case 'focus':
      return state.open ? { ...state, activeIndex: wrap(action.index, state.itemCount) } : state;
    case 'close':
      if (!state.open) return state;
      return { ...CLOSED_CHOICE, restoreFocusId: action.restoreFocus === false ? null : state.returnFocusId };
    case 'focusRestored':
      return state.restoreFocusId === null ? state : { ...state, restoreFocusId: null };
    default:
      return state;
  }
}

/** Action d'une touche dans la liste, ou `null`. */
export function choiceKeyAction(key) {
  switch (key) {
    case 'ArrowDown': return { type: 'move', delta: 1 };
    case 'ArrowUp': return { type: 'move', delta: -1 };
    case 'Home': return { type: 'first' };
    case 'End': return { type: 'last' };
    case 'Enter':
    case ' ': return { type: 'activate' };
    default: return null;
  }
}

/**
 * Cible d'un élément choisi : l'exemplaire exact et la révision courante de
 * la boîte, ou `null` pour un élément désactivé.
 */
export function choiceTarget(state, item) {
  if (!state.open || !item?.enabled) return null;
  return { exemplarId: item.id, expectedRevision: state.revision };
}
