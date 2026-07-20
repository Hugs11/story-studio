import { normalizeFrenchSearchText } from '../../utils/frenchText.js';
import { matchesNodeColor } from '../tree/nodeColorFilter.js';

export function buildVisibleTreeSearchIds({
  projectIndex,
  projectType,
  searchTerm,
  selectedColors = new Set(),
}) {
  const normalizedTerm = normalizeFrenchSearchText(searchTerm).trim();
  if ((!normalizedTerm && selectedColors.size === 0) || projectType !== 'pack') return null;

  const matching = new Set();
  for (const flatEntry of projectIndex.flatEntries ?? []) {
    const matchesTerm = !normalizedTerm
      || normalizeFrenchSearchText(flatEntry.entry.name).includes(normalizedTerm);
    if (matchesTerm && matchesNodeColor(flatEntry.entry.treeColor, selectedColors)) {
      matching.add(flatEntry.entry.id);
    }
  }

  const visible = new Set(matching);
  for (const id of matching) {
    let parentId = projectIndex.parentMenuById.get(id);
    while (parentId != null) {
      visible.add(parentId);
      parentId = projectIndex.parentMenuById.get(parentId);
    }
  }
  return visible;
}
