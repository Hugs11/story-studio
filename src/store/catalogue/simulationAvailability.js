// Disponibilité de « Simuler » pour un exemplaire, et sa raison.
//
// Ce qui est su avant toute lecture : un fichier indisponible, un état lu
// par le scan (archive corrompue ou protégée, structure invalide, format non
// pris en charge…). Un exemplaire disponible dont les capacités ne sont pas
// encore vérifiées reste actif : la simulation le qualifie à l'ouverture et
// présente alors une raison explicite.

/** Raison par état publié par le scan (table fermée, clés définitives). */
const STATE_REASONS = Object.freeze({
  corruptArchive: 'catalogue:reason.action.archiveCorrupt',
  protectedArchive: 'catalogue:reason.action.archiveProtected',
  encryptedUnknownKey: 'catalogue:reason.action.encryptedUnknownKey',
  invalidStructure: 'catalogue:reason.action.invalidPack',
  unsupportedFormat: 'catalogue:reason.action.unsupportedFormat',
  fileDisappeared: 'catalogue:reason.action.fileUnavailable',
  missing: 'catalogue:reason.action.fileUnavailable',
  unavailable: 'catalogue:reason.action.fileUnavailable',
  volumeUnavailable: 'catalogue:reason.action.fileUnavailable',
  accessDenied: 'catalogue:reason.action.fileUnavailable',
  fileUnstable: 'catalogue:reason.action.fileUnstable',
});

export const SIMULATION_REASONS = Object.freeze({
  noExemplar: 'catalogue:actions.reason.noExemplar',
  fileUnavailable: 'catalogue:reason.action.fileUnavailable',
  unsupportedFormat: 'catalogue:reason.action.unsupportedFormat',
  unreadable: 'catalogue:reason.action.unreadable',
  noSuitableExemplar: 'catalogue:reason.action.noSuitableExemplar',
});

/**
 * @param {object|null} exemplar exemplaire normalisé (`entryModel.js`)
 * @returns {{enabled: boolean, reasonKey: string|null}}
 */
export function simulationAvailability(exemplar) {
  if (!exemplar) return { enabled: false, reasonKey: SIMULATION_REASONS.noExemplar };
  if (!exemplar.format) return { enabled: false, reasonKey: SIMULATION_REASONS.unsupportedFormat };
  if (exemplar.state !== 'available') {
    return {
      enabled: false,
      reasonKey: Object.hasOwn(STATE_REASONS, exemplar.state) ? STATE_REASONS[exemplar.state] : SIMULATION_REASONS.unreadable,
    };
  }
  if (!exemplar.available) return { enabled: false, reasonKey: SIMULATION_REASONS.fileUnavailable };
  return { enabled: true, reasonKey: null };
}
