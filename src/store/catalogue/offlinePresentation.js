// Pack hors ligne (motif publié par le catalogue) : libellé court, aide et
// chemins montrés en infobulle. Rien n'est déduit : sans motif publié ou avec
// un exemplaire disponible, la fiche n'a aucune présentation hors ligne.

const parentFolder = (path) => path.replace(/[\\/]+[^\\/]*$/, '') || path;

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value !== ''))];
}

/**
 * @param {{available?: boolean, offlineReason?: string|null, exemplars?: Array}} card
 * @returns {null | {reason: 'unavailable'|'missing', paths: string[]}}
 */
export function offlinePresentation(card) {
  if (!card || card.available !== false) return null;
  const reason = card.offlineReason === 'missing' ? 'missing' : card.offlineReason === 'unavailable' ? 'unavailable' : null;
  if (!reason) return null;
  const locations = (card.exemplars ?? []).map((exemplar) => exemplar.containerPath ?? exemplar.path);
  // Disque ou réseau absent : le dossier suffit. Fichier introuvable : dernier emplacement exact.
  const paths = unique(reason === 'unavailable' ? locations.map((path) => (path ? parentFolder(path) : null)) : locations);
  return { reason, paths };
}
