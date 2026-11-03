import { normalizeSearchText } from '../../utils/frenchText.js';
export function normalizedLabel(label) { return normalizeSearchText(String(label ?? '').trim().replace(/\s+/gu, ' ')); }
export function tagCollision(tags, label, exceptId = null) {
  const key = normalizedLabel(label);
  return tags.find(tag => tag.id !== exceptId && normalizedLabel(tag.label) === key) ?? null;
}
export function tagSuggestions(tags, query) {
  const key = normalizedLabel(query);
  return tags.filter(tag => !key || normalizedLabel(tag.label).includes(key));
}
