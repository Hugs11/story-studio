// Tables fermées valeur → clé de traduction du catalogue (formats, états
// d'exemplaire, motifs de scan). Aucune clé n'est construite à l'exécution.

export const FORMAT_LABELS = Object.freeze({
  project: { labelKey: 'catalogue:format.project.label' },
  zip: { labelKey: 'catalogue:format.zip.label' },
  sevenZip: { labelKey: 'catalogue:format.sevenZip.label' },
  folder: { labelKey: 'catalogue:format.folder.label' },
});

// Motifs publiés par le scan (diagnostics réels, motif principal exclusif).
export const REASON_LABELS = Object.freeze({
  unsupportedFormat: { labelKey: 'catalogue:reason.unsupportedFormat' },
  invalidStructure: { labelKey: 'catalogue:reason.invalidStructure' },
  corruptArchive: { labelKey: 'catalogue:reason.corruptArchive' },
  protectedArchive: { labelKey: 'catalogue:reason.protectedArchive' },
  encryptedUnknownKey: { labelKey: 'catalogue:reason.encryptedUnknownKey' },
  accessDenied: { labelKey: 'catalogue:reason.accessDenied' },
  fileDisappeared: { labelKey: 'catalogue:reason.fileDisappeared' },
  volumeUnavailable: { labelKey: 'catalogue:reason.volumeUnavailable' },
  readLimitExceeded: { labelKey: 'catalogue:reason.readLimitExceeded' },
  unreadableUnknown: { labelKey: 'catalogue:reason.unreadableUnknown' },
  technicalExclusion: { labelKey: 'catalogue:reason.technicalExclusion' },
  overlappingSource: { labelKey: 'catalogue:reason.overlappingSource' },
  fileUnstable: { labelKey: 'catalogue:reason.fileUnstable' },
  itemLimitExceeded: { labelKey: 'catalogue:reason.itemLimitExceeded' },
  depthLimitExceeded: { labelKey: 'catalogue:reason.depthLimitExceeded' },
  excludedByRule: { labelKey: 'catalogue:reason.excludedByRule' },
  scanSuperseded: { labelKey: 'catalogue:reason.scanSuperseded' },
  generateFirst: { labelKey: 'catalogue:assembly.generateFirst' },
  assemblyUnavailable: { labelKey: 'catalogue:assembly.unavailable' },
  operationFailed: { labelKey: 'catalogue:reason.operationFailed' },
  cancelled: { labelKey: 'catalogue:reason.cancelled' },
});

// Un motif inconnu de cette version reste lisible sans être qualifié.
const UNKNOWN_REASON = Object.freeze({ labelKey: 'catalogue:reason.unreadableUnknown' });

export const EXEMPLAR_STATE_LABELS = Object.freeze({
  available: { labelKey: 'catalogue:exemplar.state.available' },
  missing: { labelKey: 'catalogue:exemplar.state.missing' },
  unavailable: { labelKey: 'catalogue:exemplar.state.unavailable' },
});

export function formatLabelKey(format) {
  return Object.hasOwn(FORMAT_LABELS, format) ? FORMAT_LABELS[format].labelKey : null;
}

export function reasonLabelKey(reason) {
  return (Object.hasOwn(REASON_LABELS, reason) ? REASON_LABELS[reason] : UNKNOWN_REASON).labelKey;
}

/** État d'un exemplaire : disponible, absent, inaccessible, ou motif de lecture. */
export function exemplarStateLabelKey(state) {
  return Object.hasOwn(EXEMPLAR_STATE_LABELS, state)
    ? EXEMPLAR_STATE_LABELS[state].labelKey
    : reasonLabelKey(state);
}
