// Compteurs de bilan d'une opération du catalogue : disjoints, somme,
// total inconnu, annulation avec non traités, racine en erreur, anciennes
// séquences ignorées, motifs exclusifs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptSnapshot, summarizeOperation } from '../src/store/catalogue/operationCounters.js';

function snapshot(overrides = {}) {
  return {
    operationId: 'op', requestId: 'r', sequence: 1, sourcesRevision: 1, catalogueRevision: 3, timestamp: 0,
    error: null, status: 'running', phase: 'analysis', discoveryComplete: true, scanComplete: false,
    unvisitedExtentUnknown: false, currentSourceId: null, currentDirectory: null,
    roots: { total: 1, completed: 1, failed: 0 },
    directories: { visited: 4, errors: 0, total: null },
    candidates: { discovered: 30, processed: 0, total: 30 },
    outcomes: { indexedNew: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0, refused: 0, error: 0, notProcessed: 0 },
    cards: { created: 0, updated: 0 },
    reasons: [],
    ...overrides,
  };
}

test('bilan : compteurs disjoints, processed = somme des sept résultats, motifs détaillant les refusés', () => {
  const summary = summarizeOperation(snapshot({
    status: 'partial', scanComplete: true, sequence: 9,
    candidates: { discovered: 33, processed: 33, total: 33 },
    outcomes: { indexedNew: 20, updated: 1, unchanged: 1, ignored: 0, refused: 10, error: 1, notProcessed: 0 },
    cards: { created: 12, updated: 1 },
    reasons: [
      { reason: 'unsupportedFormat', outcome: 'refused', count: 3 },
      { reason: 'corruptArchive', outcome: 'refused', count: 7 },
      { reason: 'fileUnstable', outcome: 'error', count: 1 },
    ],
  }));
  assert.equal(summary.counts.processed, 33);
  assert.equal(summary.counts.refused, 10, 'le total des refusés n’ajoute pas ses motifs');
  assert.deepEqual(summary.breakdown.refused, {
    total: 10,
    items: [
      { reason: 'corruptArchive', reasonKey: 'catalogue:reason.corruptArchive', count: 7 },
      { reason: 'unsupportedFormat', reasonKey: 'catalogue:reason.unsupportedFormat', count: 3 },
    ],
    unspecified: 0,
  });
  assert.equal(summary.breakdown.error.items[0].reason, 'fileUnstable');
  assert.deepEqual(summary.lines.map((line) => line.key), [
    'catalogue:summary.result.partial',
    'catalogue:summary.count.indexedNew',
    'catalogue:summary.count.cardsCreated',
    'catalogue:summary.count.updated',
    'catalogue:summary.count.unchanged',
    'catalogue:summary.count.refused',
    'catalogue:summary.count.error',
  ]);
  assert.deepEqual(summary.lines[1].params, { count: 20 });
  assert.equal(summary.incomplete, false);
  assert.equal(summary.progressLine, null);
});

test('motifs incomplets : le reste est sans motif détaillé, jamais compté deux fois', () => {
  const summary = summarizeOperation(snapshot({
    status: 'success', scanComplete: true,
    outcomes: { indexedNew: 0, updated: 0, removed: 0, unchanged: 0, ignored: 0, refused: 5, error: 0, notProcessed: 0 },
    reasons: [{ reason: 'invalidStructure', outcome: 'refused', count: 2 }, { reason: 'mystery', outcome: 'refused', count: 1 }],
  }));
  assert.equal(summary.breakdown.refused.unspecified, 2);
  assert.equal(summary.breakdown.refused.items.find((item) => item.reason === 'mystery').reasonKey, 'catalogue:reason.unreadableUnknown');
});

test('découverte : total inconnu, aucun pourcentage, dossiers parcourus', () => {
  const summary = summarizeOperation(snapshot({
    phase: 'discovery', discoveryComplete: false, directories: { visited: 42, errors: 0, total: null },
    candidates: { discovered: 0, processed: 0, total: null },
  }));
  assert.equal(summary.progress.total, null);
  assert.equal(summary.progress.percent, null);
  assert.deepEqual(summary.progressLine, { key: 'catalogue:progress.discovery.directories', params: { count: 42 } });
});

test('analyse pendant la découverte : dénominateur provisoire', () => {
  const summary = summarizeOperation(snapshot({
    phase: 'discovery', discoveryComplete: false, candidates: { discovered: 300, processed: 125, total: null },
  }));
  assert.equal(summary.progress.percent, null);
  assert.deepEqual(summary.progressLine, { key: 'catalogue:progress.analysis.provisional', params: { analysed: 125, count: 300 } });
});

test('analyse après le parcours, archives encore à inventorier : pas de « découverte en cours »', () => {
  const summary = summarizeOperation(snapshot({
    phase: 'analysis', discoveryComplete: false, candidates: { discovered: 300, processed: 125, total: null },
  }));
  assert.equal(summary.progress.percent, null);
  assert.deepEqual(summary.progressLine, { key: 'catalogue:progress.analysis.inventory', params: { analysed: 125, count: 300 } });
});

test('rafraîchissement automatique (aucune racine parcourue) : pas d’« inventaire des archives »', () => {
  const summary = summarizeOperation(snapshot({
    phase: 'analysis', discoveryComplete: false, roots: { total: 1, completed: 0, failed: 0 },
    candidates: { discovered: 2, processed: 1, total: null },
  }));
  assert.deepEqual(summary.progressLine, { key: 'catalogue:progress.analysis.provisional', params: { analysed: 1, count: 2 } });
});

test('analyse avec inventaire connu : pourcentage réel', () => {
  const summary = summarizeOperation(snapshot({ candidates: { discovered: 300, processed: 125, total: 300 } }));
  assert.deepEqual(summary.progressLine, { key: 'catalogue:progress.analysis.known', params: { analysed: 125, count: 300 } });
  assert.equal(summary.progress.percent, 41);
  assert.deepEqual(summarizeOperation(snapshot({ phase: 'finalization' })).progressLine.key, 'catalogue:progress.phase.finalization');
  assert.deepEqual(summarizeOperation(snapshot({ status: 'cancelling' })).progressLine.key, 'catalogue:progress.status.cancelling');
  assert.deepEqual(summarizeOperation(snapshot({ status: 'queued' })).progressLine.key, 'catalogue:progress.status.queued');
});

test('annulation : non traités parmi les découverts, étendue non parcourue inconnue, scan incomplet', () => {
  const summary = summarizeOperation(snapshot({
    status: 'cancelled', discoveryComplete: false, unvisitedExtentUnknown: true, scanComplete: false,
    candidates: { discovered: 50, processed: 20, total: null },
    outcomes: { indexedNew: 20, updated: 0, removed: 0, unchanged: 0, ignored: 0, refused: 0, error: 0, notProcessed: 30 },
  }));
  assert.equal(summary.incomplete, true);
  assert.equal(summary.counts.processed, 20);
  assert.equal(summary.counts.notProcessed, 30);
  const keys = summary.lines.map((line) => line.key);
  assert.equal(keys[0], 'catalogue:summary.result.cancelled');
  assert.ok(keys.includes('catalogue:summary.count.notProcessed'));
  assert.ok(keys.includes('catalogue:summary.scope.unvisited'));
  assert.ok(keys.includes('catalogue:summary.scan.incomplete'));
});

test('racine en erreur : scan incomplet même si tous les candidats sont analysés, erreurs comptées à part', () => {
  const summary = summarizeOperation(snapshot({
    status: 'partial', scanComplete: false, roots: { total: 2, completed: 1, failed: 1 },
    directories: { visited: 10, errors: 2, total: null },
    candidates: { discovered: 5, processed: 5, total: 5 },
    outcomes: { indexedNew: 5, updated: 0, removed: 0, unchanged: 0, ignored: 0, refused: 0, error: 0, notProcessed: 0 },
    reasons: [{ reason: 'volumeUnavailable', outcome: 'scopeError', count: 1 }, { reason: 'accessDenied', outcome: 'scopeError', count: 2 }],
  }));
  assert.equal(summary.incomplete, true);
  assert.equal(summary.counts.error, 0, 'erreurs de racine hors résultats d’exemplaires');
  assert.equal(summary.breakdown.scopeError.items.length, 2);
  const lines = Object.fromEntries(summary.lines.map((line) => [line.key, line.params]));
  assert.deepEqual(lines['catalogue:summary.scope.rootsFailed'], { count: 1 });
  assert.deepEqual(lines['catalogue:summary.scope.directoryErrors'], { count: 2 });
  assert.ok(Object.hasOwn(lines, 'catalogue:summary.scan.incomplete'));
});

test('anciennes séquences ignorées ; une autre opération remplace', () => {
  const second = snapshot({ sequence: 2 });
  const finished = snapshot({ sequence: 5, status: 'success' });
  assert.equal(acceptSnapshot(null, second), second);
  assert.equal(acceptSnapshot(second, snapshot({ sequence: 1 })), second);
  assert.equal(acceptSnapshot(second, snapshot({ sequence: 2 })), second);
  assert.equal(acceptSnapshot(second, finished), finished);
  assert.equal(acceptSnapshot(finished, snapshot({ sequence: 4, status: 'running' })), finished, 'le terminal reste');
  const other = snapshot({ operationId: 'op2', sequence: 1 });
  assert.equal(acceptSnapshot(finished, other), other);
  assert.equal(acceptSnapshot(finished, null), finished);
});

test('retrait : ligne après les mises à jour, compteur traité, absent à zéro ou dans un ancien instantané', () => {
  const summary = summarizeOperation(snapshot({
    status: 'success', scanComplete: true,
    outcomes: { updated: 2, removed: 1 },
    reasons: [{ reason: 'fileDisappeared', outcome: 'removed', count: 1 }],
  }));
  assert.equal(summary.counts.processed, 3);
  assert.equal(summary.counts.updated, 2);
  assert.equal(summary.counts.error, 0);
  assert.deepEqual(summary.lines.slice(1), [
    { key: 'catalogue:summary.count.updated', params: { count: 2 }, counter: 'updated' },
    { key: 'catalogue:summary.count.removed', params: { count: 1 }, counter: 'removed' },
  ]);
  for (const outcomes of [{ removed: 0 }, {}]) {
    const empty = summarizeOperation(snapshot({ status: 'success', scanComplete: true, outcomes }));
    assert.equal(empty.counts.removed, 0);
    assert.ok(empty.lines.every(line => line.counter !== 'removed'));
  }
});
