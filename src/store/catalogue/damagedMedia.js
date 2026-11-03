// A picture found damaged while a pack was measured at import: the engine publishes
// `{kind: 'image', screen}` on the exemplar (`damagedMedia`). Rules shared by the
// format tag, the fiche, the version choice and the send; no IPC, no rendered text.

/** Name of the exemplar as the fiche shows it (its file name). */
export function exemplarName(exemplar) {
  const path = typeof exemplar?.path === 'string' ? exemplar.path.split(/[\\/]/).filter(Boolean).pop() : null;
  return exemplar?.fileName ?? path ?? '';
}

/** Sentence naming the exemplar and, when it has one, the screen: `{key, params}`. */
export function damagedLine(exemplar) {
  const damage = exemplar?.damagedMedia;
  if (!damage) return null;
  const name = exemplarName(exemplar);
  return damage.screen
    ? { key: 'catalogue:damagedMedia.image', params: { exemplar: name, screen: damage.screen } }
    : { key: 'catalogue:damagedMedia.imageUnnamed', params: { exemplar: name } };
}

/** The engine's own refusal for such a picture: the same code and screen as a refused send. */
export function damagedRefusal(exemplar) {
  const damage = exemplar?.damagedMedia;
  if (!damage) return null;
  return damage.screen
    ? { code: 'STORYTELLER_IMAGE_UNREADABLE', params: { screen: damage.screen } }
    : { code: 'STORYTELLER_IMAGE_UNREADABLE_UNNAMED', params: {} };
}
