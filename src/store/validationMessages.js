// Validation shown in the React UI is an early, user-friendly warning layer.
// Rust remains the final generation contract and may reject additional cases.
// All helpers below use a unified em-dash separator and consistent French wording.

const SEPARATOR = ' — ';

const FIELD_LABELS = Object.freeze({
  audio: 'Audio',
  'audio intro': "Audio d'accueil",
  'audio titre': 'Audio de sélection',
  histoire: 'Histoire',
  image: 'Image',
  'image de couverture': 'Image de couverture',
  'image bibliothèque': 'Image bibliothèque',
  zip: 'Archive ZIP',
});

function fieldLabel(field) {
  return FIELD_LABELS[field] || String(field || 'Élément');
}

export function missingField(label, field, { feminine = false } = {}) {
  void feminine;
  return `${label}${SEPARATOR}${fieldLabel(field)} à ajouter`;
}

export function brokenField(label, field) {
  return `${label}${SEPARATOR}Fichier ${fieldLabel(field).toLowerCase()} introuvable`;
}

export function missingTarget(label, what) {
  return `${label}${SEPARATOR}destination ${what} introuvable`;
}

export function emptyTarget(label, what) {
  return `${label}${SEPARATOR}destination ${what} vide`;
}

export const VALIDATION_MESSAGES = Object.freeze({
  noProjectType: 'Type de projet à choisir.',
  importedTransitionUnmodeled: 'Transition importée à vérifier.',
  rootReservedId: "Identifiant réservé à corriger — aucun élément ne doit porter l'id root",
  missingInternalId: (label) => `${label}${SEPARATOR}Identifiant interne à corriger`,
  unsupportedEntryType: (label) => `${label}${SEPARATOR}Type d'élément non pris en charge`,
  refTargetMissing: (label) => `${label}${SEPARATOR}Référence sans cible`,
  reservedIdInvalid: (label) => `${label}${SEPARATOR}Identifiant réservé à corriger`,
  duplicateId: (count, entryId) => `Identifiant dupliqué${SEPARATOR}${count} éléments partagent l'id ${entryId}`,
  storyReturnLost: (label) => `${label}${SEPARATOR}Retour de fin introuvable`,
  emptyMenu: (label) => `${label}${SEPARATOR}Histoire à ajouter`,
  emptyPack: 'Histoire à ajouter dans le pack.',
});
