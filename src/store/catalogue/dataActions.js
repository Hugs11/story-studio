// Data commands have fiche targets only, never exemplar or file targets.
export function visibleTargets(ids, cards, visibleIds) {
  const selected = new Set(ids); const visible = new Set(visibleIds);
  return cards.filter(card => selected.has(card.id) && visible.has(card.id));
}
export function dataActions(targets = [], { busy = false } = {}) {
  const enabled = targets.length > 0 && !busy;
  const reasonKey = enabled ? null : busy ? 'catalogue:data.busy' : 'catalogue:data.noTarget';
  return [
    { id: 'favorite', labelKey: targets.length && targets.every(card => card.favorite) ? 'catalogue:data.unfavorite' : 'catalogue:data.favorite' },
    { id: 'tags', labelKey: 'catalogue:tags.title' },
  ].map(action => ({ ...action, enabled, reasonKey, hint: null, choice: false }));
}
