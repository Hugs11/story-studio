// Validation shown in the React UI is an early, user-friendly warning layer.
// Rust remains the final generation contract and may reject additional cases.
// All helpers below use a unified em-dash separator and consistent French wording.

const SEPARATOR = ' — ';

export function missingField(label, field, { feminine = false } = {}) {
  return `${label}${SEPARATOR}${field} ${feminine ? 'manquante' : 'manquant'}`;
}

export function brokenField(label, field) {
  return `${label}${SEPARATOR}${field} introuvable ou inaccessible`;
}

export function missingTarget(label, what) {
  return `${label}${SEPARATOR}destination ${what} introuvable`;
}

export function emptyTarget(label, what) {
  return `${label}${SEPARATOR}destination ${what} vide ou non jouable`;
}

export const VALIDATION_MESSAGES = Object.freeze({
  noProjectType: 'Aucun type de projet selectionne.',
  importedTransitionUnmodeled: 'Transition importee non modelisee.',
  rootReservedId: "Identifiant reserve utilise — aucun element ne doit porter l'id root",
  missingInternalId: (label) => `${label}${SEPARATOR}identifiant interne manquant`,
  unsupportedEntryType: (label) => `${label}${SEPARATOR}type d'element non pris en charge`,
  reservedIdInvalid: (label) => `${label}${SEPARATOR}identifiant reserve invalide`,
  duplicateId: (count, entryId) => `Identifiant duplique${SEPARATOR}${count} elements partagent l'id ${entryId}`,
  storyReturnLost: (label) => `${label}${SEPARATOR}retour de fin introuvable pour cette histoire`,
  emptyMenu: (label) => `${label}${SEPARATOR}collection vide`,
  emptyPack: 'Le pack ne contient aucune histoire.',
});
