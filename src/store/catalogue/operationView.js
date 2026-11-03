// Models contain translation keys, never rendered text. Behaviour inspired by
// STUdio Perso batchProgress tests (MPL-2.0): closing never cancels work.
import { backupResultForSummary } from './backupExportState.js';
import { acceptSnapshot, summarizeOperation } from './operationCounters.js';

export const INITIAL_OPERATIONS = Object.freeze({ items: {}, hidden: {}, dismissed: {}, retired: {}, retained: {}, registry: null, selected: null, error: null });

function pruneOperations(state) {
  // Keep the same twenty presented entries, plus live work, the open report
  // and sends whose device reservation has not yet been released.
  const visible = new Set(recentOperations(state).map(item => item.operationId));
  const items = {}, retired = { ...state.retired };
  for (const [id, item] of Object.entries(state.items)) {
    if (visible.has(id) || !summarizeOperation(item).terminal || state.retained?.[id] || state.retained?.[item.requestId] || state.selected === id) items[id] = item;
    else if (state.registry?.includes(id)) retired[id] = true;
  }
  const markers = entries => Object.fromEntries(Object.entries(entries).filter(([id]) => Object.hasOwn(items, id)));
  return { ...state, items, retired, hidden: markers(state.hidden), dismissed: markers(state.dismissed) };
}

export function operationReducer(state = INITIAL_OPERATIONS, action) {
  switch (action.type) {
    case 'snapshot': {
      let next = action.snapshot;
      if (!next?.operationId) return state;
      if (action.retainedOperationIds) {
        const registry = action.retainedOperationIds;
        // The engine never reuses expired UUIDs. Retired IDs still registered
        // need a tombstone; expired ones are rejected by registry membership.
        state = { ...state, registry, retired: Object.fromEntries(Object.entries(state.retired ?? {}).filter(([id]) => registry.includes(id))) };
        const current = state.items[next.operationId];
        if (!registry.includes(next.operationId) && !state.retained?.[next.operationId] && !state.retained?.[next.requestId]
          && (!current || summarizeOperation(current).terminal)) return state;
      }
      if (state.retired?.[next.operationId] && !action.explicit) return state;
      const previous = state.items[next.operationId];
      if (acceptSnapshot(previous, next) === previous) {
        // A report may enrich an already delivered terminal of the same sequence.
        if (previous.sequence !== next.sequence || !next.fileNames || previous.fileNames) return state;
        next = { ...previous, fileNames: next.fileNames };
      }
      const terminal = summarizeOperation(next).terminal;
      return pruneOperations({ ...state, items: { ...state.items, [next.operationId]: next },
        ...(action.explicit ? { selected: next.operationId, retired: Object.fromEntries(Object.entries(state.retired ?? {}).filter(([id]) => id !== next.operationId)) } : {}),
        // A closed tracker is followed by a fresh summary on completion.
        hidden: terminal && !summarizeOperation(previous).terminal ? { ...state.hidden, [next.operationId]: false } : state.hidden });
    }
    case 'retain': return { ...state, retained: { ...state.retained, [action.id]: true } };
    case 'release': {
      const retained = { ...state.retained };
      delete retained[action.id];
      return pruneOperations({ ...state, retained });
    }
    case 'closeTracker': return pruneOperations({ ...state, hidden: { ...state.hidden, [action.id]: true }, selected: state.selected === action.id ? null : state.selected });
    case 'dismiss': return pruneOperations({ ...state, dismissed: { ...state.dismissed, [action.id]: true }, selected: state.selected === action.id ? null : state.selected });
    case 'open': return state.items[action.id]
      ? pruneOperations({ ...state, selected: action.id, hidden: { ...state.hidden, [action.id]: false }, dismissed: { ...state.dismissed, [action.id]: false } })
      : state;
    case 'error': return { ...state, error: action.error };
    default: return state;
  }
}
export function shouldAnnounce(snapshot) {
  const view = summarizeOperation(snapshot);
  if (!view.terminal) return false;
  return Boolean(backupResultForSummary(snapshot)) || view.status !== 'success' || view.counts.indexedNew + view.counts.updated + view.counts.removed + view.counts.refused + view.counts.error > 0 || view.counts.cardsCreated > 0;
}
export function summaryLifetime(snapshot) {
  const view = summarizeOperation(snapshot);
  return view.status === 'success' && view.counts.refused === 0 && view.counts.error === 0 ? 10000 : null;
}
const OPERATION_TITLES = {
  trash: 'catalogue:operation.trash', deletePermanently: 'catalogue:operation.delete',
  duplicates: 'catalogue:operation.duplicates', assembly: 'catalogue:operation.assembly',
  luniiRepatriate: 'catalogue:lunii.repatriate', luniiSend: 'catalogue:operation.luniiSend', lunii: 'catalogue:operation.lunii', catalogueExport: 'catalogue:operation.export',
  catalogueImport: 'catalogue:operation.import',
};
const FILE_RESULTS = {
  trash: 'catalogue:operation.trashed', deletePermanently: 'catalogue:operation.deleted',
};
const OPERATION_RESULTS = {
  success: 'catalogue:operation.success', partial: 'catalogue:operation.partial',
  failed: 'catalogue:operation.failed', cancelled: 'catalogue:operation.cancelled',
};

const removalTitles = new Map();
const repatriationTitles = new Map();
export function rememberRepatriationTitle(requestId, title) {
  repatriationTitles.set(requestId, title);
  if (repatriationTitles.size > 100) repatriationTitles.delete(repatriationTitles.keys().next().value);
}
// Transfers report their terminal error on the snapshot, without journal items.
export function operationIssueItems(report, snapshot, { summaryErrorVisible = false } = {}) {
  if (report?.items?.length) return report.items;
  // The summary already displays this error. Repatriation alone needs a journal
  // fallback to associate its snapshot-only failure with the transferred title.
  const differentReportError = report?.error && JSON.stringify(report.error) !== JSON.stringify(snapshot?.error);
  if (summaryErrorVisible && snapshot?.operationKind !== 'luniiRepatriate' && !differentReportError) return [];
  const error = report?.error ?? snapshot?.error;
  if (!error) return [];
  const title = repatriationTitles.get(snapshot?.requestId);
  // Only a title remembered as absent is untitled; an unknown title (restart, evicted entry) shows nothing.
  const untitledStory = !title && repatriationTitles.has(snapshot?.requestId);
  return [{ path: title ?? '', outcome: 'refused', detail: error, ...(untitledStory ? { untitledStory: true } : {}) }];
}
function removalTitle(card, exemplar) {
  return card.displayTitle?.trim() || card.title?.trim() || exemplar.fileName?.trim() || exemplar.name?.trim() || fileBaseName(exemplar.path);
}
// One request identifies the selected fiche even if several packs share an archive.
// Keep a bounded session cache for repeated terminal delivery and reopening.
export function rememberRemovalTitle(requestId, card, exemplar) {
  removalTitles.set(requestId, removalTitle(card, exemplar));
  if (removalTitles.size > 100) removalTitles.delete(removalTitles.keys().next().value);
}
export function rememberFileTitles(titles, cards) {
  for (const card of cards) for (const exemplar of card.exemplars ?? []) {
    if (exemplar.path) titles.set(exemplar.path, removalTitle(card, exemplar));
  }
}
function fileBaseName(path = '') {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
}
// Only confirmed successes enter the notification, including partial operations.
// The first three are enough for the bounded summary; failures remain in Issues.
export async function namedFileSnapshot(snapshot, api, titles) {
  if (!FILE_RESULTS[snapshot.operationKind] || !summarizeOperation(snapshot).terminal || !(snapshot.outcomes?.updated > 0)) return snapshot;
  const names = [];
  let cursor = null;
  do {
    const page = await api.getOperation(snapshot.operationId, { limit: 100, cursor });
    for (const item of page.items ?? []) if (item.outcome === 'updated' && names.length < 3) {
      names.push((snapshot.outcomes.updated === 1 && removalTitles.get(snapshot.requestId)) || titles.get(item.path) || fileBaseName(item.path));
    }
    cursor = page.cursor;
  } while (cursor && names.length < 3);
  return { ...snapshot, fileNames: names };
}
export function operationView(snapshot) {
  const view = summarizeOperation(snapshot);
  const isScan = !snapshot?.operationKind;
  const hasIssues = Boolean(view.error) || view.counts.error + view.counts.refused + view.roots.failed + view.directories.errors > 0;
  const hasIssueItems = view.counts.error + view.counts.refused + view.roots.failed + view.directories.errors > 0
    || (Boolean(view.error) && snapshot?.operationKind === 'luniiRepatriate');
  const title = { key: OPERATION_TITLES[snapshot?.operationKind] ?? (isScan
    ? (view.terminal ? 'catalogue:summary.title.label' : 'catalogue:tracker.title.label')
    : 'catalogue:operation.title'), params: {} };
  const lines = isScan ? [...view.lines] : [];
  if (!isScan && view.terminal) {
    const resultKey = FILE_RESULTS[snapshot.operationKind];
    if (view.status !== 'success' || !resultKey) lines.push({ key: OPERATION_RESULTS[view.status], params: {} });
    if (resultKey && (view.counts.updated > 0 || view.status === 'success')) {
      const names = snapshot.fileNames ?? [];
      if (view.counts.updated === 1 && names.length) lines.push({ key: snapshot.operationKind === 'trash' ? 'catalogue:trash.trashed' : 'catalogue:trash.deleted', params: { name: names[0] } });
      else lines.push({ key: resultKey, params: { count: view.counts.updated }, ...(names.length ? { names: names.slice(0, 3), remaining: Math.max(0, view.counts.updated - Math.min(3, names.length)) } : {}) });
    }
    for (const [counter, key] of [['error', 'catalogue:operation.errors'], ['refused', 'catalogue:summary.count.refused'], ['ignored', 'catalogue:summary.count.ignored'], ['notProcessed', 'catalogue:summary.count.notProcessed']]) {
      if (view.counts[counter] > 0) lines.push({ key, params: { count: view.counts[counter] }, counter });
    }
  }
  const transfer = snapshot?.operationKind === 'luniiRepatriate' ? { progress: { ...view.progress, analysed: snapshot.result?.progress ?? 0, total: 100 }, progressLine: { key: 'catalogue:lunii.repatriateProgress', params: { percent: snapshot.result?.progress ?? 0 } } } : {};
  return { ...view, ...transfer, isScan, hasIssues, hasIssueItems, title, lines, currentDirectory: snapshot?.currentDirectory ?? null,
    rootsLine: { key: 'catalogue:tracker.roots.progress', params: { completed: view.roots.completed + view.roots.failed, total: view.roots.total } },
    announce: shouldAnnounce(snapshot), lifetime: summaryLifetime(snapshot) };
}
export function recentOperations(state) {
  return Object.values(state.items).sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
}
export function emptyCatalogueState({ sources = [], count = 0, scanning = false, loading = false, filtered = false }) {
  const active = sources.filter((s) => s.status === 'active');
  if (!active.length) return 'noSources';
  if (count === 0 && loading) return 'loading';
  if (count === 0 && scanning) return 'initialScan';
  if (active.every((s) => s.availability === 'unavailable')) return 'offline';
  if (filtered && count === 0) return 'filtered';
  return count === 0 ? 'noPacks' : 'ready';
}
export const EMPTY_KEYS = Object.freeze({
  noSources: 'catalogue:empty.noSources.message', loading: 'catalogue:empty.loading.message', initialScan: 'catalogue:empty.initialScan.message',
  offline: 'catalogue:empty.offline.message', filtered: 'catalogue:empty.filtered.message',
  noPacks: 'catalogue:empty.noPacks.message', ready: null,
});
// Latest snapshot per operation, one delivery every 250 ms including terminals.
// Fixed windows avoid starving progress under continuous discovery events.
export function createProgressBuffer({ deliver, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let pending = new Map();
  let timer = null;
  let disposed = false;
  const flush = () => {
    timer = null;
    const batch = [...pending.values()];
    pending = new Map();
    if (!disposed) deliver(batch);
  };
  return {
    push(snapshot) {
      if (disposed || !snapshot?.operationId) return;
      pending.set(snapshot.operationId, acceptSnapshot(pending.get(snapshot.operationId), snapshot));
      if (timer === null) timer = setTimer(flush, 250);
    },
    dispose() { disposed = true; if (timer !== null) clearTimer(timer); pending.clear(); },
  };
}
export function groupReport(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.outcome}:${item.reason ?? ''}`;
    if (!groups.has(key)) groups.set(key, { id: key, outcome: item.outcome, reason: item.reason, items: [] });
    groups.get(key).items.push(item);
  }
  return [...groups.values()];
}

export function summaryVisible(snapshot, state) {
  const view = operationView(snapshot);
  if (!view.terminal || state.dismissed[snapshot.operationId]) return false;
  if (state.selected === snapshot.operationId) return true;
  return view.announce;
}
// Pausing preserves the remaining time, rather than starting ten seconds anew.
export function createSummaryTimer({ duration, expire, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let remaining = duration;
  let started = 0;
  let timer = null;
  let disposed = false;
  return {
    resume() {
      if (disposed || timer !== null || remaining === null) return;
      started = now();
      timer = setTimer(() => { timer = null; remaining = 0; if (!disposed) expire(); }, remaining);
    },
    pause() {
      if (timer === null) return;
      clearTimer(timer); timer = null;
      remaining = Math.max(0, remaining - (now() - started));
    },
    dispose() { disposed = true; if (timer !== null) clearTimer(timer); timer = null; },
  };
}
