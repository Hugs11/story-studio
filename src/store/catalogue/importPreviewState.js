import { conflictFingerprint } from './importConflicts.js';
const natural = n => Number.isSafeInteger(n) && n >= 0;
const text = s => typeof s === 'string' && s.length > 0;
const hash = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
export function importSummary(dto) {
  if (!dto || !text(dto.previewId) || dto.formatVersion !== 1 || !hash(dto.backupDigest)
    || !natural(dto.expectedCatalogueRevision) || !dto.counts
    || !['cards', 'tags', 'images'].every(k => natural(dto.counts[k]))) throw new TypeError('Invalid import summary');
  return dto;
}
export function importPage(dto) {
  importSummary(dto);
  if (!natural(dto.offset) || !natural(dto.limit) || dto.limit < 1 || dto.limit > 100 || !Array.isArray(dto.issues)
    || !dto.issues.every(text)) throw new TypeError('Invalid import page');
  for (const key of ['additions', 'changes', 'conflicts', 'unresolved']) {
    const page = dto[key];
    if (!page || !natural(page.total) || !Array.isArray(page.items) || page.items.length > dto.limit
      || page.items.length !== Math.min(dto.limit, Math.max(0, page.total - dto.offset))
      || !page.items.every(row => row && text(row.id) && (row.label === undefined || text(row.label)))) throw new TypeError('Invalid import rows');
  }
  if (!dto.conflicts.items.every(c => c.defaultChoice === 'local' && c.target && (c.target.label === undefined || text(c.target.label)) && 'local' in c && 'incoming' in c)
    || !dto.unresolved.items.every(r => ['missingIdentity', 'identityNotFound', 'ambiguousIdentity', 'referenceUnavailable'].includes(r.reason))) throw new TypeError('Invalid import conflicts');
  if (dto.forgottenCount !== undefined && !natural(dto.forgottenCount)) throw new TypeError('Invalid forgotten count');
  return dto;
}
export function importResult(dto) {
  if (!dto || !['imported', 'keptLocal', 'ignored', 'unresolved', 'catalogueRevision'].every(k => natural(dto[k]))
    || !text(dto.reportId)) throw new TypeError('Invalid import result');
  return dto;
}
export const IMPORT_BUSY = new Set(['preparing', 'applying', 'cancelling', 'loading']);
export const INITIAL_IMPORT = Object.freeze({ phase: 'closed', path: '', preview: null, receipt: null, mode: null, context: null,
  sequence: -1, choices: {}, globalChoice: 'local', associations: {}, associationsDirty: false, error: null, result: null });
export function canApplyImport(state) {
  return state.phase === 'preview' && state.preview && !state.associationsDirty;
}
export function importPreviewReducer(state = INITIAL_IMPORT, event) {
  // Identity, rather than the path alone, also rejects responses after A → B → A.
  if (event.type !== 'begin' && event.context !== undefined && event.context !== state.context) return state;
  switch (event.type) {
    case 'open': return { ...INITIAL_IMPORT, phase: 'choosing', context: {} };
    case 'close': return IMPORT_BUSY.has(state.phase) ? state : INITIAL_IMPORT;
    case 'path': return IMPORT_BUSY.has(state.phase) ? state : { ...INITIAL_IMPORT, phase: 'choosing', path: event.path, context: {} };
    case 'begin': return { ...state, context: event.mode === 'preview' ? event.context ?? {} : state.context, phase: event.mode === 'preview' ? 'preparing' : 'applying', mode: event.mode, globalChoice: event.mode === 'preview' ? 'local' : state.globalChoice, receipt: null, sequence: -1, error: null, result: null };
    case 'receipt': return { ...state, receipt: event.receipt };
    case 'progress': {
      const p = event.progress;
      if (!state.receipt || p.operationId !== state.receipt.operationId || p.sequence <= state.sequence) return state;
      const next = { ...state, sequence: p.sequence };
      if (p.status === 'success') return state.mode === 'preview'
        ? { ...next, phase: 'loading' } : { ...next, phase: 'success', result: importResult(p.result) };
      if (['failed', 'partial', 'cancelled'].includes(p.status)) return { ...next, phase: p.status === 'cancelled' ? 'cancelled' : 'failed', error: p.error ?? null };
      return next;
    }
    case 'page': return { ...state, phase: 'preview', preview: importPage(event.page), associationsDirty: event.prepared ? false : state.associationsDirty };
    case 'choice': {
      const conflict = state.preview?.conflicts.items.find(c => c.id === event.id);
      if (state.phase !== 'preview' || !conflict || !['local', 'incoming'].includes(event.choice)) return state;
      return { ...state, choices: { ...state.choices, [event.id]: { choice: event.choice, fingerprint: conflictFingerprint(conflict) } } };
    }
    case 'global': return state.phase === 'preview' && ['local', 'incoming'].includes(event.choice) ? { ...state, globalChoice: event.choice } : state;
    case 'associate': return state.phase === 'preview' ? { ...state, associations: { ...state.associations, [event.id]: event.target }, associationsDirty: true } : state;
    case 'cancel': return ['preparing', 'applying'].includes(state.phase) ? { ...state, phase: 'cancelling' } : state;
    case 'trackingError': return { ...state, error: event.error };
    case 'failed': return { ...state, phase: 'failed', error: event.error };
    default: return state;
  }
}
