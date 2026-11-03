// État de chargement des fiches du catalogue et regroupement des
// rechargements déclenchés par `catalogue-changed`.
//
// Un rechargement ne remplace jamais les fiches affichées par du vide : elles
// restent visibles jusqu'à l'arrivée des nouvelles. Un échec de rechargement
// garde les fiches connues et conserve l'erreur pour la signaler.

export const INITIAL_ENTRIES_STATE = Object.freeze({
  status: 'loading',
  cards: Object.freeze([]),
  revision: null,
  error: null,
  reloading: false,
});

/**
 * @param {typeof INITIAL_ENTRIES_STATE} state
 * @param {{type: 'loadStarted'} | {type: 'loadSucceeded', cards: Array, revision: number}
 *   | {type: 'loadFailed', error: unknown}} action
 */
export function entriesReducer(state = INITIAL_ENTRIES_STATE, action) {
  switch (action.type) {
    case 'loadStarted':
      return state.status === 'loading' ? state : { ...state, reloading: true };
    case 'loadSucceeded':
      return { status: 'ready', cards: shareUnchangedCards(state.cards, action.cards), revision: action.revision, error: null, reloading: false };
    case 'favoritePatched': {
      // Only the exact successor of the loaded revision: nothing else changed.
      if (state.status !== 'ready' || state.reloading || action.revision !== state.revision + 1) return state;
      const ids = new Set(action.ids);
      return { ...state, revision: action.revision,
        cards: state.cards.map(card => ids.has(card.id) ? { ...card, favorite: action.value, ficheRevision: card.ficheRevision + 1 } : card) };
    }
    case 'loadFailed':
      return state.status === 'ready'
        ? { ...state, error: action.error, reloading: false }
        : { ...state, status: 'error', error: action.error, reloading: false };
    default:
      return state;
  }
}

// Unchanged cards keep their object across reloads, so memoized cards and
// their covers are left alone; an identical list keeps its array.
const cardKeys = new WeakMap();
function cardKey(card) {
  let key = cardKeys.get(card);
  if (key === undefined) { key = JSON.stringify(card); cardKeys.set(card, key); }
  return key;
}
export function shareUnchangedCards(previous, next) {
  if (!previous?.length || !Array.isArray(next)) return next;
  const known = new Map(previous.map(card => [card?.id, card]));
  let same = previous.length === next.length;
  const shared = next.map((card, index) => {
    const old = known.get(card?.id);
    const kept = old && old !== card && card && typeof card === 'object' && cardKey(old) === cardKey(card) ? old : card;
    if (kept !== previous[index]) same = false;
    return kept;
  });
  return same ? previous : shared;
}

/** Ligne d'état présentable, ou `null` quand les fiches sont à jour. */
export function entriesStatusLine(state) {
  if (state.status === 'loading') return { key: 'catalogue:loading.state.loading', params: {} };
  if (state.status === 'error') return { key: 'catalogue:loading.state.error', params: {} };
  if (state.error) return { key: 'catalogue:loading.state.stale', params: {} };
  return null;
}

/**
 * Regroupe les demandes de rechargement : une rafale d'événements produit un
 * seul chargement après `delay` ms ; une demande reçue pendant un chargement
 * en relance un seul autre à sa fin. Une révision déjà chargée est ignorée.
 * Les minuteries sont injectées (tests sans horloge réelle).
 */
export function createReloadScheduler({ delay = 250, run, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let timer = null;
  let running = false;
  let pending = false;
  let disposed = false;
  let loadedRevision = null;
  // Highest revision requested since the last start; Infinity for a request without one.
  let requestedRevision = null;

  async function start() {
    timer = null;
    if (disposed) return;
    if (running) { pending = true; return; }
    running = true;
    pending = false;
    requestedRevision = null;
    try {
      const revision = await run();
      // Never backwards: a load begun before a local patch must not reopen it.
      if (revision !== undefined && revision !== null) loadedRevision = Math.max(loadedRevision ?? revision, revision);
      return revision;
    } finally {
      running = false;
      if (pending && !disposed) schedule();
    }
  }

  function schedule() {
    if (disposed) return;
    if (running) { pending = true; return; }
    if (timer !== null) clearTimer(timer);
    timer = setTimer(start, delay);
  }

  return {
    /** Signale un changement ; `revision` facultative (événement du moteur). */
    request(revision = null) {
      if (revision !== null && loadedRevision !== null && revision <= loadedRevision && !running) return false;
      requestedRevision = Math.max(requestedRevision ?? -Infinity, revision ?? Infinity);
      schedule();
      return true;
    },
    /**
     * The list was brought to `revision` locally (an applied mutation): a
     * waiting reload requested for that revision or an older one is dropped.
     */
    markLoaded(revision) {
      loadedRevision = Math.max(loadedRevision ?? revision, revision);
      if (timer !== null && !running && requestedRevision !== null && requestedRevision <= revision) {
        clearTimer(timer);
        timer = null;
        requestedRevision = null;
      }
    },
    /** A load is in progress (set synchronously, before any dispatch). */
    isRunning() { return running; },
    /** Chargement immédiat (premier affichage) ; rend la révision lue, sauf si un chargement était déjà en cours. */
    now() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      return start();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}
