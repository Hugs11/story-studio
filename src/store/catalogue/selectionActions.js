import { dataActions, visibleTargets } from './dataActions.js';
import { assemblyAction } from './assemblySelection.js';

export function selectionPanelActions(targets, actions, phase, busy = false) {
  if (!targets.length) return actions;
  return [...actions,
    ...(targets.every(card => card.offlineReason === 'missing') ? [{ id: 'removeFromCatalogue', labelKey: 'catalogue:actions.removeFromCatalogue.label', enabled: !busy, reasonKey: busy ? 'catalogue:data.busy' : null }] : []),
    ...(!targets.some(card => card.available === false) ? [assemblyAction(targets.length, phase)] : []),
  ];
}
// Extension point for 4c, 5 and 6: ordered composition, without dead commands.
export function selectionActions(ids, cards, visibleIds, options) {
  const targets = visibleTargets(ids, cards, visibleIds);
  return { targets, actions: dataActions(targets, options) };
}

/** A context click keeps the selection, but only acts on it when the clicked card belongs to it. */
export function selectionMenuKind(card, targets) {
  return targets.length > 1 && targets.some(target => target.id === card.id) ? 'selection' : 'card';
}

/** The menu uses the panel's commands, including their current availability and reasons. */
export function selectionMenuEntries(actions) {
  return actions.map(action => ({ key: action.id, exemplar: null, action }));
}
