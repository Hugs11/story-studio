import { useMemo, useReducer } from 'react';

// Consolide N booléens d'ouverture de modales/overlays en un seul reducer, exposant
// une API open/close/toggle/set/isOpen(name). Remplace autant de useState épars dans
// AppContent (plan O). Les dispatchers sont stables entre les rendus ; seul l'objet
// retourné change quand un flag change (pour qu'isOpen lise l'état frais).
//
// NE PAS y absorber les flags qui portent une DONNÉE (mode d'un funnel, id de menu
// cible, payload) : ceux-là restent des useState dédiés — on perdrait l'information
// en les réduisant à un booléen.
function initState(names) {
  const state = {};
  for (const name of names) state[name] = false;
  return state;
}

function reducer(state, action) {
  switch (action.type) {
    case 'open':
      return state[action.name] ? state : { ...state, [action.name]: true };
    case 'close':
      return state[action.name] ? { ...state, [action.name]: false } : state;
    case 'toggle':
      return { ...state, [action.name]: !state[action.name] };
    case 'set': {
      const value = !!action.value;
      return state[action.name] === value ? state : { ...state, [action.name]: value };
    }
    default:
      return state;
  }
}

export function useDisclosures(names) {
  const [state, dispatch] = useReducer(reducer, names, initState);
  return useMemo(() => ({
    isOpen: (name) => !!state[name],
    open: (name) => dispatch({ type: 'open', name }),
    close: (name) => dispatch({ type: 'close', name }),
    toggle: (name) => dispatch({ type: 'toggle', name }),
    set: (name, value) => dispatch({ type: 'set', name, value }),
  }), [state]);
}
