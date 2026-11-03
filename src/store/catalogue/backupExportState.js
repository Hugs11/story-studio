// Portable backup DTOs and transitions; user data stays opaque.
const natural = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
function counts(value) {
  return value && ['cards', 'tags', 'images'].every(key => natural(value[key]));
}
export function exportPlan(dto) {
  if (!dto || !text(dto.planId) || !text(dto.destinationPath) || !natural(dto.catalogueRevision)
    || !counts(dto.counts) || !natural(dto.estimatedBytes) || !Array.isArray(dto.conflicts)
    || !dto.conflicts.every(value => value === 'destinationExists') || !Array.isArray(dto.issues)
    || !dto.issues.every(value => value === 'luniiImageMissing')) throw new TypeError('Invalid catalogue export plan');
  return dto;
}
export function exportReceipt(dto) {
  if (!dto || !text(dto.operationId) || !text(dto.requestId) || !natural(dto.catalogueRevision)
    || !natural(dto.sourcesRevision)) throw new TypeError('Invalid catalogue export receipt');
  return dto;
}
export function exportResult(dto) {
  if (!dto || !text(dto.path) || dto.formatVersion !== 1 || !natural(dto.catalogueRevision)
    || (dto.missingLuniiImages !== undefined && !natural(dto.missingLuniiImages))
    || !counts(dto.counts) || !natural(dto.byteSize) || !/^[0-9a-f]{64}$/.test(dto.digest)) throw new TypeError('Invalid catalogue export result');
  return dto;
}
export const INITIAL_EXPORT = Object.freeze({ phase: 'closed', path: '', plan: null, receipt: null, summaryValidated: false, replaceExisting: false, error: null, progress: null, result: null, sequence: -1 });
export const EXPORT_BUSY = new Set(['planning', 'starting', 'running', 'cancelling']);
export function canExport(state) {
  return state.phase === 'planned' && state.summaryValidated && state.plan?.issues.every(value => value === 'luniiImageMissing')
    && (!state.plan.conflicts.length || state.replaceExisting);
}
export function backupExportReducer(state = INITIAL_EXPORT, event) {
  switch (event.type) {
    case 'open': return { ...INITIAL_EXPORT, phase: 'choosing' };
    case 'close': return EXPORT_BUSY.has(state.phase) ? state : INITIAL_EXPORT;
    case 'path': return EXPORT_BUSY.has(state.phase) ? state : { ...INITIAL_EXPORT, phase: 'choosing', path: event.path };
    case 'planning': return { ...state, phase: 'planning', error: null, plan: null, summaryValidated: false, replaceExisting: false, result: null };
    case 'planned': return { ...state, phase: 'planned', plan: event.plan, path: event.plan.destinationPath };
    case 'summary': return { ...state, summaryValidated: event.value };
    case 'replace': return { ...state, replaceExisting: event.value };
    case 'starting': return canExport(state) ? { ...state, phase: 'starting', error: null } : state;
    case 'started': return { ...state, phase: 'running', receipt: event.receipt, sequence: -1 };
    case 'cancel': return state.phase === 'running' ? { ...state, phase: 'cancelling' } : state;
    case 'cancelError': return { ...state, phase: 'running', error: event.error };
    case 'trackingError': return { ...state, error: event.error };
    case 'progress': {
      const p = event.progress;
      if (!state.receipt || p.operationId !== state.receipt.operationId || p.sequence <= state.sequence) return state;
      const terminal = ['success', 'failed', 'cancelled', 'partial'].includes(p.status);
      return { ...state, progress: p, sequence: p.sequence, error: p.error ?? null,
        phase: terminal ? (p.status === 'success' ? 'success' : p.status === 'cancelled' ? 'cancelled' : 'failed') : state.phase,
        result: p.status === 'success' ? exportResult(p.result) : null };
    }
    case 'failed': return { ...state, phase: 'failed', plan: null, error: event.error };
    default: return state;
  }
}
export function backupResultForSummary(snapshot) {
  if (snapshot?.status !== 'success' || snapshot?.result?.formatVersion !== 1) return null;
  try { return exportResult(snapshot.result); } catch { return null; }
}
