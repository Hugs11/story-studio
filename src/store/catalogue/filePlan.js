// Files announced by a plan are immutable. A changed choice requires a new plan.
export function filePlan(dto) {
  if (!dto || typeof dto.planId !== 'string' || !Number.isFinite(dto.catalogueRevision) || !Array.isArray(dto.targets)) throw new TypeError('Invalid file plan');
  if (!dto.targets.every(t => typeof t.exemplarId === 'string' && typeof t.sourceToken === 'string'
    && typeof t.destinationPath === 'string' && Array.isArray(t.changes) && Array.isArray(t.conflicts)
    && ['copy', 'replace'].includes(t.mode) && ['available', 'unavailable'].includes(t.capability?.state))) throw new TypeError('Invalid file target');
  return dto;
}
