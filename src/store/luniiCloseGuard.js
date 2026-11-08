// Fermeture de la fenêtre pendant une opération Lunii.
//
// Trois pièces, toutes sans React pour rester testables :
//  - `luniiActivity` : registre des sources qui publient l'état des appareils
//    (aujourd'hui le store Lunii du catalogue ; la file d'opérations pourra
//    s'y brancher en fournissant `queued` et `cancelQueued`) ;
//  - `describeLuniiActivity` : résume cet état (occupé ? quel type ? titre ?) ;
//  - `createLuniiCloseGuard` : dialogue de confirmation puis attente de la fin.
// Une opération en cours n'est jamais coupée par la fermeture.

export function describeLuniiActivity(devices = [], queued = 0) {
  const busy = devices.filter(device => device?.busy);
  const queuedCount = Math.max(0, Number(queued) || 0);
  if (!busy.length) return { active: queuedCount > 0, kind: 'generic', title: null, queued: queuedCount };
  const sending = busy.find(device => device.sending);
  const subject = sending ?? busy[0];
  let title = null;
  if (!sending && subject.pendingKeys?.length === 1) {
    title = subject.stories?.find(story => story.key === subject.pendingKeys[0])?.title?.trim() || null;
  }
  return { active: true, kind: sending ? 'send' : 'generic', title, queued: queuedCount };
}

/** Source : { getSnapshot(): { luniiDevices }, subscribe(fn), queued?(): number, cancelQueued?(): void } */
export function createLuniiActivity() {
  const sources = new Set();
  const listeners = new Set();
  const unsubscribers = new Map();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    register(source) {
      sources.add(source);
      unsubscribers.set(source, source.subscribe(notify));
      notify();
      return () => {
        if (!sources.delete(source)) return;
        unsubscribers.get(source)?.();
        unsubscribers.delete(source);
        notify();
      };
    },
    snapshot() {
      const devices = [];
      let queued = 0;
      for (const source of sources) {
        devices.push(...(source.getSnapshot().luniiDevices ?? []));
        queued += source.queued?.() ?? 0;
      }
      return describeLuniiActivity(devices, queued);
    },
    cancelQueued() { for (const source of sources) source.cancelQueued?.(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export const luniiActivity = createLuniiActivity();

const ENGINE_POLL_MS = 500;
// Deux lectures calmes de suite : le moteur peut se libérer un instant entre
// deux éléments d'un lot (rapatriement de plusieurs histoires).
const QUIET_READS = 2;

/**
 * `ask(activity)` renvoie 'wait' | 'cancelRest' | autre (annuler). `confirm()`
 * renvoie 'proceed' (rien en cours), 'wait' ou 'cancel'.
 *
 * L'activité est la réunion des sources JS (store du catalogue, file) et de
 * l'inventaire du moteur (`engine.list()`), qui reste vrai même quand l'écran
 * du catalogue est fermé. Sans information du moteur, on ne déclare jamais la
 * fin : l'attente continue (au pire l'utilisateur annule la fermeture).
 */
export function createLuniiCloseGuard({ activity = luniiActivity, ask, engine, timers = globalThis, pollMs = ENGINE_POLL_MS }) {
  let waiting = false;
  let failed = false;
  let cancelWait = null;
  const listeners = new Set();
  const publish = () => { for (const listener of [...listeners]) listener(); };
  const setWaiting = value => { waiting = value; publish(); };
  const engineBusy = async () => {
    try { return { known: true, busy: (await engine.list()).some(device => device?.busy) }; } catch { return { known: false, busy: false }; }
  };
  async function snapshot() {
    const current = activity.snapshot();
    if (current.active) return current;
    const reading = await engineBusy();
    return reading.busy ? { active: true, kind: 'generic', title: null, queued: 0 } : current;
  }
  return {
    isBusy: async () => (await snapshot()).active,
    async confirm() {
      const current = await snapshot();
      if (!current.active) return 'proceed';
      const choice = await ask(current);
      if (choice === 'cancelRest' && current.queued > 0) { activity.cancelQueued(); return 'wait'; }
      return choice === 'wait' || choice === 'cancelRest' ? 'wait' : 'cancel';
    },
    /** true quand plus rien n'est en cours, false si l'attente est annulée. */
    waitIdle() {
      if (cancelWait) return Promise.resolve(false);
      failed = false;
      return new Promise(resolve => {
        let quiet = 0;
        let reading = false;
        let timer;
        let unsubscribe = () => {};
        const finish = value => {
          timers.clearInterval(timer);
          unsubscribe();
          cancelWait = null;
          setWaiting(false);
          resolve(value);
        };
        cancelWait = () => finish(false);
        const tick = async () => {
          if (!cancelWait || reading) return;
          if (activity.snapshot().active) { quiet = 0; return; }
          reading = true;
          const result = await engineBusy();
          reading = false;
          if (!cancelWait) return;
          if (!result.known || result.busy || activity.snapshot().active) { quiet = 0; return; }
          quiet += 1;
          if (quiet >= QUIET_READS) finish(true);
        };
        setWaiting(true);
        // Seule une source réellement active relance le compte des lectures calmes.
        unsubscribe = activity.subscribe(() => { if (activity.snapshot().active) quiet = 0; });
        timer = timers.setInterval(tick, pollMs);
        void tick();
      });
    },
    cancelWait: () => { cancelWait?.(); },
    isWaiting: () => waiting,
    /** La fermeture différée a échoué (réservation native prise) : à dire à l'utilisateur. */
    reportCloseFailed: () => { failed = true; publish(); },
    dismissFailure: () => { failed = false; publish(); },
    hasFailed: () => failed,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
