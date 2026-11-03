import { cardTagIds } from './entryModel.js';
export function selectionTagCounts(cards, tags) {
  return tags.map(tag => ({ ...tag, count: cards.filter(card => cardTagIds(card).includes(tag.id)).length })).filter(tag => tag.count > 0);
}
export function selectionTagMutation(cards, tag) {
  return { kind: 'changeTags', ficheIds: cards.map(card => card.id), addLabels: [], addTagIds: tag.count === cards.length ? [] : [tag.id], removeTagIds: tag.count === cards.length ? [tag.id] : [] };
}
export function selectionMetadataMutation(cards, changes) {
  return { kind: 'bulkSetMetadata', ficheIds: cards.map(card => card.id), expectedFicheRevisions: Object.fromEntries(cards.map(card => [card.id, card.ficheRevision])), changes };
}
export const SELECTION_INFO_FIELDS = ['language', 'author', 'producer', 'bonus'];
/** Common value of a text field over the selection: 'common', 'mixed' (differing, or only some have one) or 'missing' (none has one). */
export function selectionFieldValue(cards, field) {
  const values = cards.map(card => (typeof card[field] === 'string' ? card[field] : '')).map(value => value.trim() === '' ? '' : value);
  const distinct = [...new Set(values)];
  if (distinct.length === 1) return distinct[0] === '' ? { kind: 'missing' } : { kind: 'common', value: distinct[0] };
  return { kind: 'mixed' };
}
export function selectionSummary(cards) {
  const durations = cards.map(card => card.durationSeconds).filter(value => Number.isFinite(value) && value >= 0);
  const ages = cards.map(card => card.age?.min).filter(value => Number.isInteger(value) && value >= 0);
  return { duration: durations.length ? durations.reduce((sum, value) => sum + value, 0) : null, min: ages.length ? Math.min(...ages) : null, max: ages.length ? Math.max(...ages) : null };
}
export function showSelectionBar(panelVisible, count) { return panelVisible === false && count >= 2; }

export function selectionFavoriteState(cards) {
  const all = cards.length > 0 && cards.every(card => card.favorite);
  return { pressed: all ? true : cards.some(card => card.favorite) ? 'mixed' : false,
    labelKey: all ? 'catalogue:selection.panel.unfavorite' : 'catalogue:selection.panel.favorite' };
}
