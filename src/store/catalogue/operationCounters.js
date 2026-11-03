// Lecture d'un instantané de progression d'une opération du catalogue
// (événements `catalogue-operation-progress` / `-finished`, ou
// `catalogue_get_operation`).
//
// Règles : compteurs disjoints ; `processed` = somme des sept résultats
// terminaux (hors non traités) ; total inconnu pendant la découverte, jamais
// de pourcentage inventé ; annulation et racines en erreur rendent le scan
// incomplet ; les motifs détaillent un total (refusés, erreurs…) sans s'y
// additionner une seconde fois ; les erreurs de racines et de dossiers sont
// comptées à part ; les anciennes séquences d'une opération sont ignorées.

import { reasonLabelKey } from './labels.js';

export const TERMINAL_STATUSES = Object.freeze(['success', 'partial', 'failed', 'cancelled']);

const OUTCOME_FIELDS = Object.freeze(['indexedNew', 'updated', 'removed', 'unchanged', 'ignored', 'refused', 'error']);

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function optionalCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Garde de séquence : conserve l'instantané courant si `next` est plus ancien
 * ou identique pour la même opération. Une autre opération remplace.
 */
export function acceptSnapshot(current, next) {
  if (!next) return current;
  if (!current || current.operationId !== next.operationId) return next;
  return count(next.sequence) > count(current.sequence) ? next : current;
}

function breakdown(reasons, outcome, total) {
  const items = (Array.isArray(reasons) ? reasons : [])
    .filter((item) => item?.outcome === outcome && count(item.count) > 0)
    .map((item) => ({ reason: item.reason, reasonKey: reasonLabelKey(item.reason), count: count(item.count) }))
    .sort((left, right) => right.count - left.count || String(left.reason).localeCompare(String(right.reason)));
  // Le détail ne dépasse jamais le total ; le reste est « sans motif détaillé ».
  const detailed = items.reduce((sum, item) => sum + item.count, 0);
  return { total, items, unspecified: total === null ? 0 : Math.max(0, total - detailed) };
}

function progressLine(summary) {
  const { status, phase, progress, directories, roots } = summary;
  if (status === 'queued') return { key: 'catalogue:progress.status.queued', params: {} };
  if (status === 'cancelling') return { key: 'catalogue:progress.status.cancelling', params: {} };
  if (phase === 'finalization') return { key: 'catalogue:progress.phase.finalization', params: {} };
  if (phase === 'discovery' && progress.discovered === 0) {
    return { key: 'catalogue:progress.discovery.directories', params: { count: directories.visited } };
  }
  if (progress.total === null) {
    // Pendant un scan, toutes les racines parcourues (abouties ou en erreur)
    // en phase d'analyse : le total n'attend plus que l'inventaire des
    // archives (enfants des multipacks). Un rafraîchissement automatique, qui
    // ne parcourt aucune racine, garde le libellé provisoire.
    const walked = phase === 'analysis' && roots.total > 0 && roots.completed + roots.failed === roots.total;
    const key = walked ? 'catalogue:progress.analysis.inventory' : 'catalogue:progress.analysis.provisional';
    return { key, params: { analysed: progress.analysed, count: progress.discovered } };
  }
  return { key: 'catalogue:progress.analysis.known', params: { analysed: progress.analysed, count: progress.total } };
}

const RESULT_KEYS = Object.freeze({
  success: 'catalogue:summary.result.success',
  partial: 'catalogue:summary.result.partial',
  failed: 'catalogue:summary.result.failed',
  cancelled: 'catalogue:summary.result.cancelled',
});

// Lignes du bilan, dans l'ordre d'affichage ; table fermée compteur → clé.
const COUNT_LINES = Object.freeze([
  ['indexedNew', 'catalogue:summary.count.indexedNew'],
  ['cardsCreated', 'catalogue:summary.count.cardsCreated'],
  ['updated', 'catalogue:summary.count.updated'],
  ['removed', 'catalogue:summary.count.removed'],
  ['unchanged', 'catalogue:summary.count.unchanged'],
  ['ignored', 'catalogue:summary.count.ignored'],
  ['refused', 'catalogue:summary.count.refused'],
  ['error', 'catalogue:summary.count.error'],
  ['notProcessed', 'catalogue:summary.count.notProcessed'],
]);

function summaryLines(summary) {
  const lines = [{ key: RESULT_KEYS[summary.status], params: {} }];
  for (const [field, key] of COUNT_LINES) {
    const value = summary.counts[field];
    if (value > 0) lines.push({ key, params: { count: value }, counter: field });
  }
  if (summary.roots.failed > 0) lines.push({ key: 'catalogue:summary.scope.rootsFailed', params: { count: summary.roots.failed } });
  if (summary.directories.errors > 0) lines.push({ key: 'catalogue:summary.scope.directoryErrors', params: { count: summary.directories.errors } });
  if (summary.unvisitedExtentUnknown) lines.push({ key: 'catalogue:summary.scope.unvisited', params: {} });
  if (summary.incomplete) lines.push({ key: 'catalogue:summary.scan.incomplete', params: {} });
  return lines;
}

/**
 * Résumé présentable d'un instantané : compteurs, avancement, détail des
 * motifs et lignes en clés de traduction.
 */
export function summarizeOperation(snapshot) {
  const outcomes = snapshot?.outcomes ?? {};
  const counts = Object.fromEntries(OUTCOME_FIELDS.map((field) => [field, count(outcomes[field])]));
  counts.notProcessed = count(outcomes.notProcessed);
  counts.processed = OUTCOME_FIELDS.reduce((sum, field) => sum + counts[field], 0);
  counts.cardsCreated = count(snapshot?.cards?.created);
  counts.cardsUpdated = count(snapshot?.cards?.updated);
  const status = typeof snapshot?.status === 'string' ? snapshot.status : 'queued';
  const terminal = TERMINAL_STATUSES.includes(status);
  const discoveryComplete = snapshot?.discoveryComplete === true;
  const roots = { total: count(snapshot?.roots?.total), completed: count(snapshot?.roots?.completed), failed: count(snapshot?.roots?.failed) };
  const directories = { visited: count(snapshot?.directories?.visited), errors: count(snapshot?.directories?.errors) };
  const discovered = count(snapshot?.candidates?.discovered);
  const analysed = count(snapshot?.candidates?.processed);
  // Le total n'est final qu'une fois la découverte terminée.
  const total = discoveryComplete ? (optionalCount(snapshot?.candidates?.total) ?? discovered) : null;
  const progress = {
    analysed,
    discovered,
    total,
    percent: total !== null && total > 0 ? Math.min(100, Math.floor((analysed * 100) / total)) : null,
  };
  const unvisitedExtentUnknown = snapshot?.unvisitedExtentUnknown === true && (terminal || status === 'cancelling');
  const incomplete = terminal && (status === 'cancelled' || status === 'failed' || roots.failed > 0 || snapshot?.scanComplete !== true);
  const summary = {
    operationId: snapshot?.operationId ?? null,
    sequence: count(snapshot?.sequence),
    status,
    phase: typeof snapshot?.phase === 'string' ? snapshot.phase : 'discovery',
    terminal,
    incomplete,
    discoveryComplete,
    unvisitedExtentUnknown,
    counts,
    roots,
    directories,
    progress,
    breakdown: {
      refused: breakdown(snapshot?.reasons, 'refused', counts.refused),
      error: breakdown(snapshot?.reasons, 'error', counts.error),
      ignored: breakdown(snapshot?.reasons, 'ignored', counts.ignored),
      // Racines et dossiers : à part des résultats d'exemplaires.
      scopeError: breakdown(snapshot?.reasons, 'scopeError', null),
    },
    error: snapshot?.error ?? null,
  };
  summary.progressLine = terminal ? null : progressLine(summary);
  summary.lines = terminal ? summaryLines(summary) : [];
  return summary;
}
