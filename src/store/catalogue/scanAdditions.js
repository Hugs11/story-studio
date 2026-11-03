// Paths are case-sensitive here: published locators already carry the native
// identity. Matching also includes the archive member, not just its container.
export function scanAdditionIds(cards, report) {
  const added = new Set(report.filter(item => item.outcome === 'indexedNew').map(item => JSON.stringify([item.path,item.member ?? null])));
  return cards.filter(card => card.exemplars.some(exemplar => added.has(JSON.stringify([exemplar.path,exemplar.member ?? null])))).map(card => card.id);
}
export async function loadScanAdditions(api, operationId) {
  const items = [];
  let cursor = null;
  do {
    const page = await api.getOperation(operationId,{ limit:200,cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

// Keep locators until presentation: the report can arrive before the new index.
// Legacy id selections remain accepted for callers selecting already known cards.
export function filterScanAdditions(cards, additions) {
  if (additions === null) return cards;
  const ids = new Set(additions.some(item => typeof item === 'object') ? scanAdditionIds(cards, additions) : additions);
  return cards.filter(card => ids.has(card.id));
}
