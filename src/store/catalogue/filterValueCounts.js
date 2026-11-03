import { runPipeline } from './pipeline.js';
import { cardTagIds } from './entryModel.js';
import { FILTER_MENU_TOGGLES } from './filterState.js';

/** Les étiquettes comptent historiquement toutes les fiches, sans recherche ni
 * filtres. Les autres menus remplacent seulement leur famille dans les critères.
 * Masquer les officielles compte les fiches retirées, sans sa propre bascule. */
export function filterValueCounts(cards, { filters, query } = {}, { family, values } = {}) {
  if (family === 'tags') return Object.fromEntries(values.map(tag => [tag.id, cards.filter(card => cardTagIds(card).includes(tag.id)).length]));
  const count = (key, value) => runPipeline(cards, { query, filters: { ...filters, [key]: value } }).counts.fiches;
  if (family) return Object.fromEntries(values.map(item => {
    const value = typeof item === 'object' ? item.id : item;
    return [value, count(family, [value])];
  }));
  return Object.fromEntries(FILTER_MENU_TOGGLES.map(item => [item.family, item.family === 'hideOfficial'
    ? runPipeline(cards.filter(card => card.official === true), { query, filters: { ...filters, hideOfficial: false } }).counts.fiches
    : count(item.family, true)]));
}
