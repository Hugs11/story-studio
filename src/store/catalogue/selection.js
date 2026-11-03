// Sélection multiple du catalogue, par identifiant de fiche, commune aux
// trois vues. Clic simple : remplace ; Ctrl/Cmd : ajoute ou retire ; Maj :
// plage entre l'ancre et la fiche, sur l'ordre affiché ; tout sélectionner :
// résultats filtrés seulement.

export const EMPTY_SELECTION = Object.freeze({ ids: Object.freeze([]), anchor: null });

/**
 * @param {{ids: string[], anchor: string|null}} state
 * @param {{type: 'click'|'toggle'|'range'|'selectAll'|'clear'|'prune', id?: string, order?: string[]}} action
 *   `order` : identifiants affichés, dans l'ordre (plage et tout sélectionner).
 */
export function selectionReducer(state = EMPTY_SELECTION, action) {
  switch (action.type) {
    case 'restore':
      return action.value ?? EMPTY_SELECTION;
    case 'click':
      return { ids: [action.id], anchor: action.id };
    case 'toggle': {
      const present = state.ids.includes(action.id);
      return {
        ids: present ? state.ids.filter((id) => id !== action.id) : [...state.ids, action.id],
        anchor: action.id,
      };
    }
    case 'range': {
      const order = action.order ?? [];
      const target = order.indexOf(action.id);
      const anchorIndex = state.anchor === null ? -1 : order.indexOf(state.anchor);
      if (target < 0) return state;
      // Sans ancre visible, la plage se réduit à la fiche, qui devient l'ancre.
      if (anchorIndex < 0) return { ids: [action.id], anchor: action.id };
      const [start, end] = anchorIndex <= target ? [anchorIndex, target] : [target, anchorIndex];
      return { ids: order.slice(start, end + 1), anchor: state.anchor };
    }
    case 'selectAll':
      return { ids: [...(action.order ?? [])], anchor: state.anchor };
    case 'clear':
      return EMPTY_SELECTION;
    case 'prune':
      return pruneSelection(state, action.order ?? []).selection;
    default:
      return state;
  }
}

/**
 * Retire de la sélection les fiches devenues invisibles (filtre, recherche,
 * rescan) et renvoie leurs identifiants pour l'annoncer. Aucune action
 * groupée ne porte sur une fiche masquée.
 */
export function pruneSelection(state, visibleIds) {
  const visible = new Set(visibleIds);
  const removed = state.ids.filter((id) => !visible.has(id));
  if (!removed.length) return { selection: state, removed };
  return {
    selection: {
      ids: state.ids.filter((id) => visible.has(id)),
      anchor: state.anchor !== null && visible.has(state.anchor) ? state.anchor : null,
    },
    removed,
  };
}

/** Annonce regroupée d'un retrait, ou `null` s'il n'y en a pas. */
export function prunedAnnouncement(removed, titles) {
  if (removed.length && titles) return { key: 'catalogue:selection.hidden.removedNamed', params: { count: removed.length, titles: titles.slice(0, 8).join('; ') } };
  return removed.length
    ? { key: 'catalogue:selection.hidden.removed', params: { count: removed.length } }
    : null;
}
