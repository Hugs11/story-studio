export const GENERATION_FILTER_STATES = Object.freeze(['modifiedSince']);

/** D43: evidence is supplied by Story Studio, never reconstructed from dates. */
export function generationState(value) {
  const state = ['upToDate', 'modifiedSince'].includes(value?.state) ? value.state : 'unknown';
  return { state, outputExemplarId: typeof value?.outputExemplarId === 'string' ? value.outputExemplarId : null };
}
export function generationTag(value) {
  return generationState(value).state === 'modifiedSince'
    ? { regenerate: true, reason: { key: 'catalogue:generation.modified.reason', params: {} } }
    : { regenerate: false, reason: null };
}
/** Unknown and up-to-date have no visible state label. */
export function generationFilterState(exemplars) {
  return exemplars.some(e => e.format === 'project' && generationTag(e.generation).regenerate) ? 'modifiedSince' : null;
}
