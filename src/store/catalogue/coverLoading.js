// The browser owns image bytes and decoding. HEAD is diagnostic only, after
// img.onerror; no custom headers (the native protocol has no OPTIONS handler).
export const COVER_LOADING_DELAY = 1000;
// Three image attempts in total, including any immediate HEAD-ready retry.
export const COVER_MAX_ATTEMPTS = 3;
const HEAD_TIMEOUT = 5000;
// Fingerprinted addresses remain valid for the whole session, including failures.
const terminalStates = new Map();

export function coverRetryDelay(value, attempt, now = Date.now()) {
  const seconds = value?.trim() ? Number(value) : NaN;
  const deadline = value ? Date.parse(value) : NaN;
  const serverDelay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
    : Number.isFinite(deadline) ? Math.max(0, deadline - now) : 0;
  return Math.max(1000 * 2 ** attempt, serverDelay);
}

export function initialCoverState(address) {
  return { phase: address ? terminalStates.get(address) ?? 'waiting' : 'absent', attempt: 0, fade: false };
}

export function coverAttemptAddress(address, attempt) {
  return attempt ? `${address}?r=${attempt}` : address;
}

export function createCoverLoading({ address, changed, request = fetch,
  schedule = setTimeout, cancel = clearTimeout, now = Date.now }) {
  let state = initialCoverState(address);
  let disposed = false, settled = state.phase !== 'waiting', diagnosing = false, retriedReady = false;
  let loadingTimer, retryTimer, headTimer, controller;
  const publish = patch => {
    if (disposed) return;
    state = { ...state, ...patch };
    changed(state);
  };
  const stopTimers = () => {
    cancel(loadingTimer); cancel(retryTimer); cancel(headTimer);
    controller?.abort();
  };
  const finish = (phase, fade = false) => {
    settled = true;
    if (address && ['absent', 'unreadable', 'tooLarge', 'offline'].includes(phase)) terminalStates.set(address, phase);
    stopTimers();
    publish({ phase, fade });
  };
  const retry = retryAfter => {
    if (state.attempt + 1 >= COVER_MAX_ATTEMPTS) { finish('unreadable'); return; }
    retryTimer = schedule(() => {
      retryTimer = null;
      if (!disposed && !settled) publish({ attempt: state.attempt + 1 });
    }, coverRetryDelay(retryAfter, state.attempt, now()));
  };
  return {
    start(image) {
      if (settled || disposed) return;
      // A cached image must be visible on the first paint, without a fade.
      if (image?.complete && image.naturalWidth > 0) { finish('ready'); return; }
      loadingTimer = schedule(() => {
        if (!settled) publish({ phase: 'loading' });
      }, COVER_LOADING_DELAY);
      if (image?.complete) void this.failed();
    },
    loaded() { if (!disposed && !settled) finish('ready', true); },
    async failed() {
      if (disposed || settled || diagnosing || retryTimer != null) return;
      diagnosing = true;
      controller = new AbortController();
      try {
        // Race as well as abort: a stalled bridge cannot hold the diagnostic forever.
        const response = await Promise.race([
          request(coverAttemptAddress(address, state.attempt), { method: 'HEAD', signal: controller.signal }),
          new Promise((_, reject) => {
            headTimer = schedule(() => { controller.abort(); reject(new Error('cover HEAD timeout')); }, HEAD_TIMEOUT);
          }),
        ]);
        if (disposed || settled) return;
        const kind = response.headers.get('x-cover-state');
        if (kind === 'offline') finish('offline');
        else if (kind === 'ready' && response.status === 200) {
          // HEAD may have produced the image after the GET encountered busy.
          if (retriedReady || state.attempt + 1 >= COVER_MAX_ATTEMPTS) finish('unreadable');
          else { retriedReady = true; publish({ attempt: state.attempt + 1 }); }
        }
        else if (kind === 'busy') retry(response.headers.get('Retry-After'));
        else if (kind === 'stale' || response.status === 410) finish('stale');
        else if (kind === 'absent' || response.status === 204 || response.status === 404) finish('absent');
        else if (kind === 'tooLarge' || response.status === 413) finish('tooLarge');
        else if (response.status === 503) retry(response.headers.get('Retry-After'));
        else finish('unreadable');
      } catch {
        if (!disposed && !settled) retry(null);
      } finally {
        cancel(headTimer);
        diagnosing = false;
      }
    },
    dispose() { disposed = true; stopTimers(); },
  };
}
