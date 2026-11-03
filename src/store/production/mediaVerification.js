import { productionRef } from '../../i18n/productionPresentation.js';
import { readPathExistence } from '../fileMetadataCache.js';
import { getGenerateErrors } from '../projectValidation.js';

const PRODUCTION_QUERY_TIMEOUT_MS = 12000;

// Ne revérifier que les observations suspectes. Les requêtes sont directes,
// indépendantes des snapshots et des lectures d'aperçu en cours ; même si le
// transport ne répond jamais, cette porte rend son verdict après 12 secondes.
export async function recheckProductionPaths(statusByPath, verifyPath = readPathExistence) {
  const candidates = Object.entries(statusByPath)
    .filter(([, status]) => status === false || status === null);
  return Object.fromEntries(await Promise.all(candidates.map(async ([path]) => {
    let status;
    try {
      status = await verifyPath(path, { timeoutMs: PRODUCTION_QUERY_TIMEOUT_MS });
    } catch {
      status = null;
    }
    return [path, typeof status === 'boolean' ? status : null];
  })));
}

export function mediaVerificationProblem() {
  return {
    title: productionRef('production:refusal.verification.title'),
    message: productionRef('production:refusal.verification.message'),
  };
}

// La validation commune décide quels fichiers sont employés (fins inactives,
// images héritées, etc.). Ne pas créer une seconde règle d'activité ici.
export async function verifyMenuProduction(project, fileAudit = {}) {
  const structuralErrors = getGenerateErrors(project);
  const candidates = Object.fromEntries(Object.entries(fileAudit).filter(([path, status]) => (
    (status === false || status === null)
      && getGenerateErrors(project, { [path]: false }).length > structuralErrors.length
  )));
  const checked = await recheckProductionPaths(candidates);
  return {
    errors: getGenerateErrors(project, { ...fileAudit, ...checked }),
    unverifiedPaths: Object.keys(checked).filter((path) => checked[path] === null),
    statusByPath: { ...fileAudit, ...checked },
  };
}
