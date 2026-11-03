import { normalizeSearchText } from '../../utils/frenchText.js';
import { matchCard, searchWords } from './search.js';

export { CRITERIA } from './filterState.js';
const WORDS = [
  { words: ['favori', 'favorite', 'favourite', 'preferit'], family: 'favoritesOnly', key: 'catalogue:filter.favorites.only', value: true },
  { words: ['completer', 'complete', 'completare'], family: 'incompleteOnly', key: 'catalogue:palette.incomplete', value: true },
  { words: ['projet', 'project', 'progetto'], family: 'formats', key: 'catalogue:format.project.label', value: ['project'] },
  { words: ['zip'], family: 'formats', key: 'catalogue:format.zip.label', value: ['zip'] },
  { words: ['7z'], family: 'formats', key: 'catalogue:format.sevenZip.label', value: ['sevenZip'] },
  { words: ['dossier', 'folder', 'cartella'], family: 'formats', key: 'catalogue:format.folder.label', value: ['folder'] },
  { words: ['introuvable', 'missing', 'introvabil'], family: 'missingFilesOnly', key: 'catalogue:filter.missingFiles.label', value: true },
];
export function paletteSuggestions(query, tags = []) {
  const text = normalizeSearchText(query).trim();
  if (!text) return [];
  const suggestions = [];
  const number = text.match(/(?<![\d-])\b(\d{1,2})\b/u);
  if (number && Number(number[1]) <= 18) suggestions.push({ family: 'age', key: 'catalogue:palette.ageSuggestion', params: { count: Number(number[1]) }, value: { min: null, max: Number(number[1]), hideUnknown: false } });
  for (const item of WORDS) if (item.words.some(word => text.includes(word))) suggestions.push(item);
  for (const tag of tags) if (normalizeSearchText(tag.label).includes(text)) suggestions.push({ family: 'tags', key: 'catalogue:palette.tagSuggestion', params: { label: tag.label }, value: { ids: [tag.id], mode: 'any' } });
  return suggestions;
}
export function paletteCards(cards, query) {
  const words = searchWords(query);
  if (!words.length) return [];
  const matches = [];
  for (const card of cards) { if (matchCard(card, words) !== null) matches.push(card); if (matches.length === 6) break; }
  return matches;
}
export function suggestionAction(suggestion, filters) {
  return { type: 'set', family: suggestion.family, value: suggestion.family === 'tags' ? { ids: [...new Set([...filters.tags.ids, ...suggestion.value.ids])], mode: 'any' } : suggestion.family === 'formats' ? [...new Set([...filters.formats, ...suggestion.value])] : suggestion.value };
}
/** Input keeps focus; the highlighted option is exposed through aria-activedescendant. */
export function paletteKey(key, { open, active, count }) {
  if (key === 'Escape') return { command: open ? 'close' : 'clear' };
  if ((key === 'ArrowDown' || key === 'ArrowUp') && count) return { command: 'move', active: !open || active < 0 ? (key === 'ArrowDown' ? 0 : count - 1) : (active + (key === 'ArrowDown' ? 1 : -1) + count) % count };
  if (key === 'Enter' && open && count) return { command: 'choose', active: active < 0 ? 0 : Math.min(active, count - 1) };
  return null;
}
export function compactTagLabel(ids, tags) {
  const labels = ids.slice(0, 2).map(id => tags.find(tag => tag.id === id)?.label ?? id);
  return labels.join(', ') + (ids.length > 2 ? ` +${ids.length - 2}` : '');
}
