// Cadence et fermeture du cache de vue.
//
// La discipline est celle, déjà en place, de la file d'écriture du fichier de
// reprise (`enqueueEphemeralSnapshotWrite`, `store/ephemeralSnapshotSeed.js`) :
// une chaîne de promesses, un jeton de session, et un contrôle de jeton
// **après** l'attente comme avant l'écriture. Ce module la reprend plutôt que
// d'en inventer une seconde.
//
// Trois interdits explicites, qui sont la raison d'être de tout le fichier :
// mémoriser un zoom ne doit **jamais** promouvoir une session éphémère,
// réécrire le `.mbah` de l'auteur, ni déclencher la garde de sauvegarde à la
// fermeture.

// Repos de navigation avant écriture.
export const REST_DELAY_MS = 800;
// Plafond pendant un mouvement continu, depuis le premier changement non écrit.
export const MOVEMENT_CEILING_MS = 5_000;
// Attente maximale à la fermeture. Au-delà, l'application se ferme quand même :
// la fermeture n'est **jamais** bloquée par le cache.
const CLOSE_FLUSH_TIMEOUT_MS = 1_000;
// Pannes consécutives après lesquelles l'écrivain se désarme pour la session.
const CONSECUTIVE_FAILURES_BEFORE_DISARM = 2;

// Fenêtre de perte annoncée : un arrêt brutal peut perdre jusqu'à `REST_DELAY_MS`
// de gestes de vue au repos, et jusqu'à `MOVEMENT_CEILING_MS` pendant un
// panoramique continu. C'est la contrepartie de ne pas écrire à chaque image.
export const ANNOUNCED_LOSS_WINDOW_MS = Object.freeze({
  atRest: REST_DELAY_MS,
  duringContinuousMovement: MOVEMENT_CEILING_MS,
});

// Écrivain différé d'une seule entrée de cache.
//
// `write` reçoit **toujours la dernière révision de vue**, jamais une valeur
// capturée avant l'attente : `snapshot()` est rappelé au moment de l'écriture.
// C'est ce qui distingue « écrire plus tard » de « écrire une valeur périmée ».
export function createViewCacheWriter({
  write,
  snapshot,
  now = () => Date.now(),
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (handle) => clearTimeout(handle),
  onFailure = () => {},
  restDelayMs = REST_DELAY_MS,
  movementCeilingMs = MOVEMENT_CEILING_MS,
}) {
  let timer = null;
  let firstUnwrittenAt = null;
  let revision = 0;
  let attempted = 0;
  let consecutiveFailures = 0;
  let disarmed = false;
  let inFlight = null;
  let lastWriteFailed = false;

  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function arm() {
    cancelTimer();
    const elapsed = firstUnwrittenAt === null ? 0 : now() - firstUnwrittenAt;
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, Math.min(restDelayMs, Math.max(0, movementCeilingMs - elapsed)));
  }

  async function drain() {
    // Une seule vidange, même si fermeture et timer la demandent ensemble.
    // Un geste pendant l'attente est inclus avant de déclarer la vidange finie.
    while (!disarmed && attempted < revision) {
      const writingRevision = revision;
      try {
        await write(snapshot());
        consecutiveFailures = 0;
        lastWriteFailed = false;
      } catch (error) {
        lastWriteFailed = true;
        consecutiveFailures += 1;
        if (consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_DISARM) disarmed = true;
        onFailure(error, { consecutiveFailures, disarmed });
      }
      attempted = writingRevision;
    }
    firstUnwrittenAt = null;
  }
  function flush() {
    cancelTimer();
    if (!inFlight) {
      // Installer la promesse avant d'appeler le transport, même réentrant.
      inFlight = Promise.resolve().then(drain).finally(() => {
        inFlight = null;
        if (!disarmed && attempted < revision) {
          firstUnwrittenAt ??= now();
          arm();
        }
      });
    }
    return inFlight;
  }

  return {
    noteChange() {
      if (disarmed) return;
      revision += 1;
      if (firstUnwrittenAt === null) firstUnwrittenAt = now();
      if (!inFlight) arm();
    },
    async flushNow({ timeoutMs = CLOSE_FLUSH_TIMEOUT_MS } = {}) {
      cancelTimer();
      if (disarmed) return { flushed: false, reason: 'disarmed' };
      if (attempted === revision && !inFlight) return { flushed: false, reason: 'nothing-pending' };
      const pending = flush();
      const result = () => lastWriteFailed
        ? { flushed: false, reason: 'failed' } : { flushed: true };
      if (timeoutMs === null) {
        await pending;
        return result();
      }
      const timedOut = Symbol('timeout');
      let handle = null;
      const deadline = new Promise(resolve => {
        handle = setTimer(() => resolve(timedOut), timeoutMs);
      });
      const outcome = await Promise.race([pending.then(result), deadline]);
      if (handle !== null) clearTimer(handle);
      return outcome === timedOut ? { flushed: false, reason: 'timeout' } : outcome;
    },
    get pending() { return attempted < revision || inFlight !== null; },
    get disarmed() { return disarmed; },
  };
}
