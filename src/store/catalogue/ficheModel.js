// Contenu de la fiche complète, en lecture seule : valeurs de référence et
// leur provenance, âge (extrait du nom, conflit de préfixes, valeurs
// invalides), état de la référence, tableau des exemplaires avec chemin
// complet. Aucune valeur n'est déduite : une donnée absente est « non
// renseignée », et une référence introuvable est signalée sans basculer
// silencieusement vers un autre fichier.

import { ageCell, dateCell, detailsRow, exemplarRow, textCell, versionCell } from './detailsRow.js';
import { formatTags } from './formatTag.js';

const AGE_NOTES = Object.freeze({
  name: { key: 'catalogue:fiche.age.fromName', params: {} },
  conflict: { key: 'catalogue:fiche.age.nameConflict', params: {} },
  outOfRange: { key: 'catalogue:fiche.age.outOfRange', params: {} },
  minAboveMax: { key: 'catalogue:fiche.age.minAboveMax', params: {} },
});

function ageNotes(age) {
  const notes = [];
  if (age?.origin === 'name') notes.push(AGE_NOTES.name);
  if (age?.conflict) notes.push(AGE_NOTES.conflict);
  if (age?.reason === 'outOfRange') notes.push(AGE_NOTES.outOfRange);
  if (age?.reason === 'minAboveMax') notes.push(AGE_NOTES.minAboveMax);
  return notes;
}

/** Provenance des valeurs affichées : exemplaire de référence et son état. */
function referenceInfo(card) {
  const reference = card.exemplars.find((exemplar) => exemplar.id === card.referenceExemplarId) ?? null;
  if (card.referenceUnavailable) {
    return {
      unavailable: true,
      exemplarId: reference?.id ?? null,
      line: reference
        ? { key: 'catalogue:fiche.reference.unavailable', params: { name: reference.fileName ?? reference.path ?? '' } }
        : { key: 'catalogue:fiche.reference.unknown', params: {} },
    };
  }
  if (!reference) return { unavailable: false, exemplarId: null, line: { key: 'catalogue:fiche.reference.none', params: {} } };
  return {
    unavailable: false,
    exemplarId: reference.id,
    line: { key: 'catalogue:fiche.reference.source', params: { name: reference.fileName ?? reference.path ?? '' } },
  };
}

/**
 * @param {object} card fiche normalisée
 * @param {{exemplars?: Array}} [options] exemplaires présentés (par défaut tous)
 */
export function ficheModel(card, { exemplars = card.exemplars } = {}) {
  const reference = referenceInfo(card);
  const referenceExemplar = card.exemplars.find((exemplar) => exemplar.id === reference.exemplarId) ?? null;
  const row = detailsRow(card, referenceExemplar);
  return {
    id: card.id,
    title: row.title,
    reference,
    tags: formatTags(exemplars),
    fields: [
      { id: 'description', labelKey: 'catalogue:details.column.summary', cell: row.summary },
      { id: 'author', labelKey: 'catalogue:details.column.author', cell: row.author },
      { id: 'age', labelKey: 'catalogue:details.column.age', cell: ageCell(card.age), notes: ageNotes(card.age) },
      { id: 'language', labelKey: 'catalogue:details.column.language', cell: row.language },
      { id: 'duration', labelKey: 'catalogue:details.column.duration', cell: row.duration },
      { id: 'stories', labelKey: 'catalogue:details.column.stories', cell: row.stories },
      { id: 'version', labelKey: 'catalogue:details.column.version', cell: versionCell(referenceExemplar?.versionDeclared ?? null) },
      { id: 'uuid', labelKey: 'catalogue:fiche.field.uuid', cell: card.uuids.length ? { kind: 'text', value: card.uuids.join('\n') } : textCell(null) },
      { id: 'addedAt', labelKey: 'catalogue:fiche.field.addedAt', cell: dateCell(card.addedAt) },
    ],
    exemplars: exemplars.map((exemplar) => ({
      ...exemplarRow(exemplar),
      reference: exemplar.id === reference.exemplarId,
    })),
  };
}
