import { cardModel } from './cardModel.js';
import { draftChanges, valueText } from './metadataDraft.js';
import { descriptionText } from './descriptionText.js';

export function ficheDraftChanges(draft) {
  const changes = draftChanges(draft, { singleAge: true });
  // A fiche edits “from N years”: clear the effective ceiling atomically (the engine
  // requires both bounds in one batch), while leaving its source value in the catalogue.
  if (changes.some(change => change.field === 'ageMin')) {
    return [...changes.filter(change => change.field !== 'ageMax'), { field: 'ageMax', state: 'cleared' }];
  }
  return changes;
}

// Durée et nombre d'histoires restent des mesures du pack : jamais retouchables.
export const EDITABLE_FIELDS = ['title', 'cover', 'ageMin', 'description', 'language', 'author', 'producer', 'bonus'];
// Localized variants remain in the draft untouched; only the primary text is edited.
export function editableFields(card) {
  return cardModel(card).fields.filter(field => EDITABLE_FIELDS.includes(field.field) && !field.language)
    .sort((a, b) => EDITABLE_FIELDS.indexOf(a.field) - EDITABLE_FIELDS.indexOf(b.field));
}
/**
 * Typing back the value shown from the source (after touching the field) is no
 * correction: the field stays on its source, so no mutation fixes the value.
 */
export function editFieldValue(value, original = null) {
  if (original?.state === 'source' && value.trim() === sourceFieldText(original).trim()) return { state: 'source', value: '' };
  return { state: value === '' ? 'cleared' : 'defined', value };
}
/** Text the editor starts from for a source value (a description's markup is shown converted). */
export function sourceFieldText(entry) {
  const text = valueText(entry.field, entry.sourceValue === undefined ? entry.effective : entry.sourceValue);
  return entry.field === 'description' ? descriptionText(text) : text;
}
export function shownFieldValue(entry) {
  return entry.state === 'defined' ? entry.value : entry.state === 'cleared' ? '' : valueText(entry.field, entry.sourceValue === undefined ? entry.effective : entry.sourceValue);
}
