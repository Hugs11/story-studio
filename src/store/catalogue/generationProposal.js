import { parentPath } from './formatTag.js';

export function generationFolder(outputPath) { return parentPath(outputPath); }
/** D75: project saving never calls this production-only proposal. */
export function shouldProposeGenerationFolder({ event = 'generated', explanation, declined = false }) {
  return event === 'generated' && !!explanation && !explanation.coveredBySourceId && !explanation.excluded && !declined;
}
