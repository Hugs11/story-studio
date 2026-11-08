// Session-only queues: reports outlive device cards and screen subscriptions.
const sessions = new WeakMap();
export function luniiQueueSession(key) {
  if (!sessions.has(key)) sessions.set(key, { entries: {}, listeners: new Set() });
  return sessions.get(key);
}
const fault = reason => reason?.deviceFault === true || reason?.userMessage?.deviceFault === true;

/** One runner per device. execute must include native termination, busy release and reread. */
export function createLuniiQueue({ execute, acquire = () => {}, release = () => {}, session = { entries: {}, listeners: new Set() }, changed = () => {} }) {
  let records = Object.fromEntries(Object.entries(session.entries).map(([id, entries]) => [id, entries.map(entry => ({ ...entry, keys: [...entry.keys] }))]));
  const runners = new Map();
  const blocked = new Map();
  const failedRepatriations = new Map();
  const jobs = new Map();
  // A run gathers the entries queued while one runner works: one end-of-queue report per run.
  const runs = new Map();
  const publish = () => {
    session.entries = Object.fromEntries(Object.entries(records).map(([id, entries]) => [id, entries.map(entry => ({ ...entry, keys: [...entry.keys] }))]));
    changed(session.entries);
    for (const listener of session.listeners) listener();
  };
  const entries = id => records[id] ?? [];
  function stop(id, reason) {
    blocked.set(id, reason);
    for (const entry of entries(id)) if (entry.state === 'queued') {
      entry.state = 'notStarted'; entry.reason = reason;
      jobs.get(entry.id)?.resolve(null); jobs.delete(entry.id);
    }
    publish();
  }
  async function run(id) {
    if (runners.has(id)) return;
    const token = {};
    runners.set(id, token);
    acquire(id);
    try {
      for (;;) {
        const entry = entries(id).find(entry => entry.state === 'queued');
        if (!entry || blocked.has(id)) break;
        const job = jobs.get(entry.id);
        if (entry.kind === 'remove') {
          const failures = failedRepatriations.get(id) ?? new Map();
          const excluded = entry.keys.filter(key => failures.has(key));
          if (excluded.length) {
            entry.reason = { excluded: excluded.map(key => ({ key, reason: failures.get(key) })) };
            entry.keys = entry.keys.filter(key => !failures.has(key));
          }
          if (!entry.keys.length) { entry.state = 'cancelled'; publish(); job.resolve(null); jobs.delete(entry.id); continue; }
        }
        entry.state = 'running'; publish();
        let result = null;
        try {
          result = await execute(id, entry, job.payload);
          entry.state = 'done';
        } catch (error) {
          entry.state = 'failed';
          entry.reason = entry.reason?.excluded ? { ...error, excluded: entry.reason.excluded } : error;
          if (entry.kind === 'repatriate') {
            if (!failedRepatriations.has(id)) failedRepatriations.set(id, new Map());
            for (const key of entry.keys) failedRepatriations.get(id).set(key, error);
          }
          if (fault(error)) stop(id, error);
        }
        jobs.delete(entry.id); publish(); job.resolve(result);
      }
    } finally { runners.delete(id); release(id); }
  }
  return {
    // Plain data only on the published entry: what the list needs to show it while it waits.
    enqueue(deviceId, { kind, keys = [], title = '', dropIndex, rowKey, items, deviceName, ...payload }) {
      // A new explicit gesture starts a new run; old queued entries never restart.
      if (!runners.has(deviceId)) { blocked.delete(deviceId); failedRepatriations.delete(deviceId); runs.set(deviceId, crypto.randomUUID()); }
      const id = crypto.randomUUID();
      let resolve;
      const finished = new Promise(done => { resolve = done; });
      const shown = { dropIndex, rowKey, items, args: payload.args, deviceName, run: runs.get(deviceId) };
      const entry = { id, kind, keys: [...keys], title, state: 'queued', reason: null, ...Object.fromEntries(Object.entries(shown).filter(([, value]) => value !== undefined)) };
      records = { ...records, [deviceId]: [...entries(deviceId), entry] };
      jobs.set(id, { payload, resolve });
      if (blocked.has(deviceId)) { entry.state = 'notStarted'; entry.reason = blocked.get(deviceId); resolve(null); jobs.delete(id); }
      publish(); void run(deviceId);
      return { id, finished };
    },
    cancel(entryId) {
      const entry = Object.values(records).flat().find(entry => entry.id === entryId);
      if (entry?.state !== 'queued') return false;
      entry.state = 'cancelled'; jobs.get(entryId)?.resolve(null); jobs.delete(entryId); publish(); return true;
    },
    queued: () => Object.values(records).flat().filter(entry => entry.state === 'queued').length,
    // All devices (closing the app), or one device (« Annuler le reste » of its ejection).
    cancelQueued(deviceId) { for (const entry of deviceId === undefined ? Object.values(records).flat() : entries(deviceId)) if (entry.state === 'queued') this.cancel(entry.id); },
    /** The report of a run was read and closed: it is not shown again this session. */
    dismissReport(deviceId, run) {
      let changed = false;
      for (const entry of entries(deviceId)) if (entry.run === run && !entry.reported) { entry.reported = true; changed = true; }
      if (changed) publish();
    },
    disconnect: id => stop(id, { code: 'STORYTELLER_DEVICE_GONE', params: {}, deviceFault: true }),
    active: id => runners.has(id),
    getSnapshot: () => session.entries,
    subscribe(listener) { session.listeners.add(listener); return () => session.listeners.delete(listener); },
  };
}
