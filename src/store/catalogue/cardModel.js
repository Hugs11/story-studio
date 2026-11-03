// Display metadata only: effective-value precedence belongs to Rust.
export const FIELD_LABELS = Object.freeze({
  title: 'catalogue:fiche.edit.field.title', subtitle: 'catalogue:fiche.edit.field.subtitle', description: 'catalogue:fiche.edit.field.description',
  versionDeclared: 'catalogue:fiche.edit.field.versionDeclared', cover: 'catalogue:fiche.edit.field.cover',
  ageMin: 'catalogue:fiche.edit.field.ageMin', ageMax: 'catalogue:fiche.edit.field.ageMax',
  language: 'catalogue:fiche.edit.field.language', author: 'catalogue:fiche.edit.field.author',
  producer: 'catalogue:fiche.edit.field.producer', bonus: 'catalogue:fiche.edit.field.bonus',
  keywords: 'catalogue:fiche.edit.field.keywords', durationSeconds: 'catalogue:fiche.edit.field.durationSeconds',
  storyCount: 'catalogue:fiche.edit.field.storyCount',
});
export const ORIGIN_KEYS = Object.freeze({ correction: 'catalogue:fiche.edit.origin.correction', reference: 'catalogue:fiche.edit.origin.reference', lunii: 'catalogue:fiche.edit.origin.lunii', filename: 'catalogue:fiche.edit.origin.filename', cleared: 'catalogue:fiche.edit.origin.cleared', none: 'catalogue:fiche.edit.origin.none' });
export const fieldId = ({ field, language = '' }) => JSON.stringify([field, language]);
export function displayValue(value) { return value === null || value === undefined ? null : typeof value === 'object' ? JSON.stringify(value) : String(value); }
export function cardModel(card) {
  const fields = (card?.fields ?? []).map(field => {
    const p = card.provenance?.find(p => p.id === field.referenceValue?.provenanceId);
    const retainedProvenance = card.provenance?.find(p => p.id === (field.effective.origin === 'correction' ? field.correction?.provenanceId : field.derived?.provenanceId ?? field.referenceValue?.provenanceId));
    const exemplar = card.exemplars?.find(e => e.id === p?.exemplarId);
    const filename = (field.effective.origin === 'filename' ? field.derived?.filename : exemplar?.member ?? exemplar?.path ?? field.derived?.filename) ?? '';
    return { ...field, retainedProvenance, id: fieldId(field), labelKey: FIELD_LABELS[field.field], value: displayValue(field.effective.value),
      originKey: ORIGIN_KEYS[field.effective.origin] ?? ORIGIN_KEYS.none, filename: ['reference', 'filename'].includes(field.effective.origin) ? filename : '', referenceFilename: exemplar?.member ?? exemplar?.path ?? '',
      invalidKey: field.invalid?.length ? 'catalogue:fiche.edit.invalid' : null,
      conflictKey: field.derived?.conflict?.length ? (field.field === 'title' ? 'catalogue:fiche.edit.titleConflict' : 'catalogue:fiche.edit.prefixConflict') : null };
  });
  const min = fields.find(f => f.field === 'ageMin')?.effective.value;
  const max = fields.find(f => f.field === 'ageMax')?.effective.value;
  return { fields, unavailable: card?.reference?.state !== 'available', partialAge: (min != null) !== (max != null) };
}
