import { generationTag } from './generationState.js';
// Étiquettes de format d'une fiche : une par format présent, dans l'ordre fixe
// Projet, ZIP, 7z, Dossier ; exemplaires du plus récent au plus ancien, tous
// conservés. Modèle commun aux trois vues et à la fiche complète : il porte des
// clés de traduction et leurs paramètres, jamais de texte rendu.
//
// Un pack enfant d'une archive multipack est déjà rangé par le moteur dans le
// format de son conteneur ; l'étiquette le mentionne (« dans <archive> »).

import { FORMAT_ORDER, compareExemplars } from './entryModel.js';
import { formatLabelKey } from './labels.js';
import { damagedLine } from './damagedMedia.js';

/** Nom de fichier d'un chemin (séparateurs des trois plateformes). */
export function baseName(path) {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Dossier d'un chemin, séparateur d'origine conservé ; `null` à la racine. */
export function parentPath(path) {
  if (typeof path !== 'string' || !path) return null;
  const trimmed = path.replace(/[\\/]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return null;
  if (index === 2 && /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.slice(0, 3);
  return index === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, index);
}

/** Archive qui contient un exemplaire enfant, ou `null`. */
export function containerName(exemplar) {
  return exemplar?.member ? baseName(exemplar.containerPath ?? exemplar.path) : null;
}

/**
 * @param {Array} exemplars exemplaires présentés (ceux qui satisfont les filtres)
 * @returns {Array<{format: string, labelKey: string, count: number,
 *   exemplarIds: string[], allUnavailable: boolean, regenerate: boolean,
 *   damaged: Array<{exemplarId: string, line: object}>,
 *   archive: string|null, countLine: object|null, mentions: object[], accessibleLine: object}>}
 */
export function formatTags(exemplars) {
  const list = Array.isArray(exemplars) ? exemplars : [];
  return FORMAT_ORDER.flatMap((format) => {
    const members = list.filter((exemplar) => exemplar.format === format).sort(compareExemplars);
    if (!members.length) return [];
    const count = members.length;
    const allUnavailable = members.every((exemplar) => !exemplar.available);
    // La mention n'est portée par l'étiquette que si elle vaut pour tous ses
    // exemplaires ; sinon chaque ligne de la fiche porte la sienne.
    const archives = new Set(members.map(containerName));
    const archive = archives.size === 1 ? [...archives][0] : null;
    const mentions = [];
    if (archive) mentions.push({ key: 'catalogue:formatTag.inArchive', params: { archive } });
    if (allUnavailable) mentions.push({ key: 'catalogue:formatTag.unavailable', params: {} });
    const regeneration = format === 'project' && members.some(member => generationTag(member.generation).regenerate);
    if (regeneration) mentions.push({ key: 'catalogue:generation.modified.reason', params: {} });
    return [{
      format,
      labelKey: formatLabelKey(format),
      count,
      exemplarIds: members.map((exemplar) => exemplar.id),
      allUnavailable,
      // Only a recorded generation receipt can enable this state.
      regenerate: regeneration,
      // Copies with a picture found damaged at import: the tag carries a « ! ».
      damaged: members.filter(member => member.damagedMedia).map(member => ({ exemplarId: member.id, line: damagedLine(member) })),
      archive,
      countLine: count > 1 ? { key: 'catalogue:formatTag.count', params: { n: count } } : null,
      mentions,
      accessibleLine: { key: 'catalogue:formatTag.inspect', params: { count } },
    }];
  });
}
