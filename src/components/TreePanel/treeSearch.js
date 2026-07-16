import { normalizeFrenchSearchText } from '../../utils/frenchText.js';

export function buildVisibleTreeSearchIds({
  projectIndex,
  projectType,
  searchTerm,
}) {
  const normalizedTerm = normalizeFrenchSearchText(searchTerm).trim();
  if (!normalizedTerm || projectType !== 'pack') return null;

  const matching = new Set();
  for (const flatEntry of projectIndex.flatEntries ?? []) {
    if (normalizeFrenchSearchText(flatEntry.entry.name).includes(normalizedTerm)) {
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
