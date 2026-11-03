// Optimistic favorites: the star changes on the click, before the engine
// answers. An override holds the requested value of a card until the loaded
// list carries it: refused gestures are rolled back at once, committed ones
// stay until a list of their revision (or later) arrives, so the star never
// shows the old value in between and a second click reads the requested one.
// Entry: card id → { value, settled, revision } (settled once the engine answered).

export const NO_FAVORITE_OVERRIDES = Object.freeze(new Map());

/** Cards with their pending favorite value; untouched cards keep their object. */
export function applyFavoriteOverrides(cards, overrides) {
  if (!overrides?.size) return cards;
  return cards.map(card => {
    const entry = overrides.get(card.id);
    return entry && entry.value !== card.favorite ? { ...card, favorite: entry.value } : card;
  });
}

export function withFavoriteOverrides(overrides, ids, value) {
  const next = new Map(overrides);
  for (const id of ids) next.set(id, { value, settled: false, revision: null });
  return next;
}

/** Committed gesture: kept until the list reaches `revision` or shows the value. */
export function settleFavoriteOverrides(overrides, ids, value, revision = null) {
  const mine = id => overrides.get(id)?.value === value && !overrides.get(id).settled;
  if (!ids.some(mine)) return overrides;
  const next = new Map(overrides);
  for (const id of ids) if (mine(id)) next.set(id, { value, settled: true, revision });
  return next;
}

/** Refused gesture: only its in-flight overrides; a later gesture on the same card keeps its own. */
export function withoutFavoriteOverrides(overrides, ids, value) {
  const mine = id => overrides.get(id)?.value === value && !overrides.get(id).settled;
  if (!ids.some(mine)) return overrides;
  const next = new Map(overrides);
  for (const id of ids) if (mine(id)) next.delete(id);
  return next.size ? next : NO_FAVORITE_OVERRIDES;
}

/**
 * Drops settled overrides the list has caught up with: the card shows the
 * value, the list reached the committed revision, or the card left the list.
 * In-flight overrides are kept.
 */
export function reconcileFavoriteOverrides(overrides, cards, listRevision) {
  if (!overrides?.size) return overrides;
  const byId = new Map(cards.map(card => [card.id, card]));
  let next = null;
  for (const [id, entry] of overrides) {
    if (!entry.settled) continue;
    const card = byId.get(id);
    if (!card || card.favorite === entry.value || (entry.revision !== null && listRevision !== null && listRevision >= entry.revision)) {
      next ??= new Map(overrides);
      next.delete(id);
    }
  }
  if (!next) return overrides;
  return next.size ? next : NO_FAVORITE_OVERRIDES;
}
