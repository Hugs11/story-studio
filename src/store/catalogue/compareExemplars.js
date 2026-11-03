import { FIELD_LABELS, fieldId } from './cardModel.js';
// Each cell is an exemplar's own candidate. Age bounds never cross columns.
export function compareExemplars(exemplars) {
  return Object.entries(FIELD_LABELS).flatMap(([field, labelKey]) => {
    const languages = new Set(['']);
    for (const e of exemplars) for (const cell of Object.values(e.fields ?? {})) {
      if (cell.field === field) languages.add(cell.language ?? '');
    }
    return [...languages].sort().map(language => {
      const id = fieldId({ field, language });
      const cells = exemplars.map(e => e.fields?.[language ? id : field] ?? null);
      const signature = cell => JSON.stringify(cell && { presence: cell.presence, validity: cell.validity, value: cell.value, raw: cell.raw });
      return { id, field, language, labelKey, cells, different: new Set(cells.map(signature)).size > 1 };
    });
  });
}
