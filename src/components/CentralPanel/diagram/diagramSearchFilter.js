import { normalizeFrenchSearchText } from '../../../utils/frenchText.js';

export function filterDiagramSearchCandidates(candidates, term, limit = 12) {
  const normalizedTerm = normalizeFrenchSearchText(term).trim();
  if (!normalizedTerm) return [];

  return (candidates ?? [])
    .filter((candidate) => (
      normalizeFrenchSearchText(candidate.label).includes(normalizedTerm)
    ))
    .slice(0, limit);
}
