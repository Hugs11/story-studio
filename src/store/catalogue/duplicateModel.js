// Diagnostics are explicit requests and are never fields of a catalogue card.
export function duplicatePage(dto) {
  if (!dto || !Array.isArray(dto.exactGroups) || !Array.isArray(dto.olderVersions) || !Array.isArray(dto.issues)
    || !dto.exactGroups.every(g => typeof g.digest === 'string' && Array.isArray(g.exemplarIds) && g.exemplarIds.every(id => typeof id === 'string'))
    || !dto.olderVersions.every(g => typeof g.uuid === 'string' && typeof g.format === 'string' && Array.isArray(g.exemplarIds) && g.exemplarIds.every(id => typeof id === 'string'))
    || !(dto.cursor === null || Number.isSafeInteger(dto.cursor) && dto.cursor >= 0)) throw new TypeError('Invalid duplicate diagnostics');
  return dto;
}
export function appendDuplicatePage(current, next) {
  return { exactGroups: [...current.exactGroups, ...next.exactGroups], olderVersions: [...current.olderVersions, ...next.olderVersions], issues: [...current.issues, ...next.issues], cursor: next.cursor };
}
export const emptyDuplicateResults = () => ({ exactGroups: [], olderVersions: [], issues: [], cursor: null });
const CHECKABLE_FORMATS = ['zip', '7z', 'studioDirectory', 'fsDirectory', 'fsZip'];
/** Le format est celui d'un pack vérifiable (indépendamment de sa disponibilité du moment). */
export function isCheckablePack(exemplar) { return CHECKABLE_FORMATS.includes(exemplar?.technicalFormat ?? exemplar?.format); }
export function checkerAvailability(exemplar) {
  return isCheckablePack(exemplar)
    && exemplar?.state === 'available' && exemplar?.available !== false && exemplar?.availability !== 'unavailable'
    ? { enabled: true, reasonKey: null }
    : { enabled: false, reasonKey: 'catalogue:diagnostics.checkerUnavailable' };
}
export function checkerEntry(dto) {
  if (!dto || typeof dto.preparationId !== 'string' || typeof dto.zipPath !== 'string'
    || typeof dto.contentToken !== 'string' || typeof dto.temporary !== 'boolean'
    || typeof dto.source?.exemplarId !== 'string' || typeof dto.source.path !== 'string') throw new TypeError('Invalid checker preparation');
  return dto;
}

export function checkerOutputDirectory(entry) {
  const path = entry.source.path;
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return separator < 0 ? '' : path.slice(0, separator + 1);
}
