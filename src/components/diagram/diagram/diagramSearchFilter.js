import { normalizeFrenchSearchText } from '../../../utils/frenchText.js';
import { matchesNodeColor } from '../../tree/nodeColorFilter.js';

export function filterDiagramSearchCandidates(
  candidates,
  term,
  limit = 12,
  selectedColors = new Set(),
) {
  const normalizedTerm = normalizeFrenchSearchText(term).trim();
  if (!normalizedTerm && selectedColors.size === 0) return [];

  return (candidates ?? [])
    .filter((candidate) => (
      (!normalizedTerm || normalizeFrenchSearchText(candidate.label).includes(normalizedTerm))
      && matchesNodeColor(candidate.treeColor, selectedColors)
    ))
    .slice(0, limit);
}

export function buildDiagramSearchContextIds(matchingIds, parentMenuById) {
  const contextIds = new Set();
  if (!matchingIds || matchingIds.size === 0) return contextIds;

  for (const id of matchingIds) {
    let parentId = parentMenuById?.get(id) ?? null;
    while (parentId != null) {
      contextIds.add(parentId);
      parentId = parentMenuById?.get(parentId) ?? null;
    }
  }
  contextIds.add('root');
  for (const id of matchingIds) contextIds.delete(id);
  return contextIds;
}

export function diagramEntryMatchesSearch(entry, matchingIds) {
  if (matchingIds?.has(entry?.id)) return true;
  return entry?.type === 'story-group'
    && entry.storyIds?.some((storyId) => matchingIds?.has(storyId));
}
