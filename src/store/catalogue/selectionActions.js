import { dataActions, visibleTargets } from './dataActions.js';
// Extension point for 4c, 5 and 6: ordered composition, without dead commands.
export function selectionActions(ids, cards, visibleIds, options) {
  const targets = visibleTargets(ids, cards, visibleIds);
  return { targets, actions: dataActions(targets, options) };
}
