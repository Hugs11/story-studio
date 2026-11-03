// Textes copiés depuis le catalogue : UUID, titre (le chemin sert à « Afficher »). Chaque cible dit
// soit le texte exact à copier, soit la raison pour laquelle la commande est
// désactivée (elle reste visible).

function available(text) {
  return { text, enabled: true, reasonKey: null };
}

function unavailable(reasonKey) {
  return { text: null, enabled: false, reasonKey };
}

/**
 * Chemin réel d'un exemplaire. Un enfant d'archive n'a pas de chemin propre
 * sur le disque : c'est celui de son archive qui est copié (comme pour
 * « Afficher dans l'explorateur »).
 */
export function pathText(exemplar) {
  const path = exemplar?.member ? (exemplar.containerPath ?? exemplar.path) : exemplar?.path;
  return typeof path === 'string' && path ? available(path) : unavailable('catalogue:actions.reason.noPath');
}

/** UUID fiable d'un exemplaire, ou celui de la fiche s'il est unique. */
export function uuidText(card, exemplar = null) {
  if (exemplar) return exemplar.uuid ? available(exemplar.uuid) : unavailable('catalogue:actions.reason.noUuid');
  const uuids = Array.isArray(card?.uuids) ? card.uuids : [];
  if (uuids.length === 1) return available(uuids[0]);
  return unavailable(uuids.length ? 'catalogue:actions.reason.severalUuids' : 'catalogue:actions.reason.noUuid');
}

export function titleText(card) {
  const title = card?.displayTitle ?? card?.title;
  return typeof title === 'string' && title.trim()
    ? available(title)
    : unavailable('catalogue:actions.reason.noTitle');
}

/** Texte à copier pour une commande `copyUuid` ou `copyTitle`. */
export function clipboardText(command, card, exemplar = null) {
  switch (command) {
    case 'copyUuid': return uuidText(card, exemplar);
    case 'copyTitle': return titleText(card);
    default: return unavailable('catalogue:actions.reason.noPath');
  }
}
