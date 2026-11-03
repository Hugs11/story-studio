import { presentUserMessage } from '../i18n/userMessage.js';

const message = (code, params = {}) => presentUserMessage({ code, params }).message;

const FIELD_LABELS = Object.freeze({
  "audio": 'VALIDATION_PROJECT_FIELD_AUDIO',
  "audio intro": 'VALIDATION_PROJECT_FIELD_INTRO_AUDIO',
  "audio titre": 'VALIDATION_PROJECT_FIELD_TITLE_AUDIO',
  "histoire": 'VALIDATION_PROJECT_FIELD_STORY',
  "image": 'VALIDATION_PROJECT_FIELD_IMAGE',
  "image de couverture": 'VALIDATION_PROJECT_FIELD_COVER_IMAGE',
  "image biblioth\u00e8que": 'VALIDATION_PROJECT_FIELD_LIBRARY_IMAGE',
  "zip": 'VALIDATION_PROJECT_FIELD_ZIP',
  "audio de fin d'histoire": 'VALIDATION_PROJECT_FIELD_ENDING_AUDIO',
  "audio de la r\u00e9action Accueil": 'VALIDATION_PROJECT_FIELD_HOME_AUDIO',
  "image de la r\u00e9action Accueil": 'VALIDATION_PROJECT_FIELD_HOME_IMAGE',
  "vignette catalogue": 'VALIDATION_PROJECT_FIELD_CATALOG_IMAGE',
  "dossier": 'VALIDATION_PROJECT_FIELD_FOLDER',
  "": 'VALIDATION_PROJECT_FIELD_ELEMENT',
});

export const validationLabel = (code, params = {}) => ({ code, params });
function fieldLabel(field) {
  if (field && typeof field === 'object' && field.code) return field;
  const code = FIELD_LABELS[field || ''];
  return code ? validationLabel(code) : String(field);
}
function lowerField(field) {
  const value = fieldLabel(field);
  return value && typeof value === 'object' ? { ...value, case: 'lower' } : value.toLowerCase();
}

export function missingField(label, field, { feminine = false } = {}) {
  void feminine;
  return message('VALIDATION_PROJECT_UI_MISSING_FIELD', { label, field: fieldLabel(field) });
}
export function brokenField(label, field) {
  return message('VALIDATION_PROJECT_UI_BROKEN_FIELD', { label, field: lowerField(field) });
}
export function missingTarget(label, what) {
  return message('VALIDATION_PROJECT_UI_MISSING_TARGET', { label, what: lowerField(what) });
}
export function emptyTarget(label, what) {
  return message('VALIDATION_PROJECT_UI_EMPTY_TARGET', { label, what: lowerField(what) });
}
export const VALIDATION_MESSAGES = Object.freeze({
  get noProjectType() { return message('VALIDATION_PROJECT_UI_NO_TYPE'); },
  get importedTransitionUnmodeled() { return message('VALIDATION_UI_IMPORTED_TRANSITION'); },
  get rootReservedId() { return message('VALIDATION_PROJECT_UI_ROOT_RESERVED'); },
  missingInternalId: (label) => message('VALIDATION_PROJECT_UI_MISSING_ID', { label }),
  unsupportedEntryType: (label) => message('VALIDATION_PROJECT_UI_UNSUPPORTED_TYPE', { label }),
  reservedIdInvalid: (label) => message('VALIDATION_PROJECT_UI_RESERVED_ID', { label }),
  duplicateId: (count, entryId) => message('VALIDATION_PROJECT_UI_DUPLICATE_ID', { count, entryId }),
  storyReturnLost: (label) => message('VALIDATION_PROJECT_UI_LOST_RETURN', { label }),
  storyWithoutExit: (label) => message('VALIDATION_PROJECT_UI_STORY_EXIT', { label }),
  emptyMenu: (label) => message('VALIDATION_PROJECT_UI_EMPTY_MENU', { label }),
  get emptyPack() { return message('VALIDATION_PROJECT_UI_EMPTY_PACK'); },
});
