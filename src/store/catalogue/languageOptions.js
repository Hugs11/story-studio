// Content codes are independent of interface language and filename markers.
export const LANGUAGE_OPTIONS = Object.freeze([
  ['fr', 'catalogue:fiche.edit.language.fr'], ['en', 'catalogue:fiche.edit.language.en'], ['it', 'catalogue:fiche.edit.language.it'],
  ['de', 'catalogue:fiche.edit.language.de'], ['es', 'catalogue:fiche.edit.language.es'], ['pt', 'catalogue:fiche.edit.language.pt'],
  ['nl', 'catalogue:fiche.edit.language.nl'], ['ca', 'catalogue:fiche.edit.language.ca'], ['eu', 'catalogue:fiche.edit.language.eu'],
  ['br', 'catalogue:fiche.edit.language.br'], ['oc', 'catalogue:fiche.edit.language.oc'], ['ar', 'catalogue:fiche.edit.language.ar'],
]);
export const validLanguage = code => /^[a-z]{2,3}$/.test(code);
/** Name of a content language in the interface language; a code missing from the table is shown as is. */
export function languageLabel(code, t) {
  for (const [known, key] of LANGUAGE_OPTIONS) if (known === code) return t(key);
  return code;
}
