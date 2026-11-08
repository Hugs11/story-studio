import { createLuniiQueue, luniiQueueSession } from './luniiQueue.js';
import { queueSendInterruption, sendReport, sendTerminal } from './luniiSend.js';
import { KEYS, read, write } from '../persistentSettings.js';
import { generateConventionName } from '../../utils/packConvention.js';
import { cardTitle } from './entryModel.js';
import { rememberRepatriationTitle } from './operationView.js';

export const LUNII_PANEL_WIDTH = Object.freeze({ min: 330, initial: 330 });

// How long a write may stay silent before the Lunii is held as stopped.
// A send emits at most every 100 ms while copying; its longest silent phases are the generation of a
// project and the final flush of a slow card, a few minutes at worst: 10 min of total silence is a stop.
export const LUNII_OPERATION_SILENCE_MS = 10 * 60 * 1000;
// Cancellation is read at every 128 KiB block and between steps, then a deletion and a flush: seconds.
export const LUNII_CANCEL_LIMIT_MS = 2 * 60 * 1000;
// Synchronous commands (remove, reorder, hide, rename, name, repair, restore, orphans) are small
// writes and a flush; their IPC answer also starts a tracked send or repatriation.
export const LUNII_COMMAND_LIMIT_MS = 2 * 60 * 1000;
// Some commands treat N stories in one IPC call: removal deletes each story folder synchronously
// (thousands of small files on a slow FAT card over USB); putting orphans back handles each one.
// Their bound grows with that real work, so 30 removed stories never look like a stopped Lunii.
export const LUNII_COMMAND_PER_STORY_MS = 30 * 1000;
const PER_STORY_COMMANDS = Object.freeze(['remove', 'restoreOrphans']);
// From then on the panel says that the Lunii does not answer, without stopping anything.
export const LUNII_SILENCE_NOTICE_MS = 60 * 1000;
// Fallback reading of an operation whose events may have been lost.
const LUNII_POLL_MS = 500;

/** Device order is authoritative. Parked orphans remain orphans, after the list. */
export function luniiRows(device) {
  let position = 0;
  return [
    ...(device?.stories ?? []).map(story => ({ ...story, orphan: false, position: story.hidden ? null : ++position })),
    ...(device?.orphans ?? []).map(story => ({ ...story, orphan: true, position: null })),
  ];
}
export function sideSelection(side, ids) { return { side, ids: [...new Set(ids)] }; }

/** IPC stays injectable; one session queue owns each device until it drains. */
export function createLuniiDevices(api, settings = { read, write }, timers = globalThis, resolveWorkspace = async () => {
  const configuredWorkspaceDir = settings.read(KEYS.WORKSPACE_DIR);
  try {
    return configuredWorkspaceDir || await (await import('../projectIO.js')).ensureWorkspaceDir();
  } catch {
    throw { code: 'STORYTELLER_WORKSPACE_UNAVAILABLE', params: {} };
  }
}) {
  let state = {
    luniiQueue: {}, luniiDevices: [], activeLuniiId: settings.read(KEYS.ACTIVE_LUNII_ID),
    luniiPanelCollapsed: settings.read(KEYS.LUNII_PANEL_COLLAPSED) === 'true',
    luniiPanelWidth: Math.max(LUNII_PANEL_WIDTH.min, Number(settings.read(KEYS.LUNII_PANEL_WIDTH)) || LUNII_PANEL_WIDTH.initial),
    fichePanelWidth: Math.max(1, Number(settings.read(KEYS.CATALOGUE_FICHE_WIDTH)) || 420),
    selection: sideSelection('catalogue', []), error: null, errorQueueEntryId: null, notice: null, conflictKey: null, conflictDeviceId: null, mutationError: false,
  };
  const listeners = new Set();
  const requests = new Map();
  const departures = new Map();
  let stopped = false;
  let stopListening;
  let stopCatalogueListening;
  let watchSession;
  const ejecting = new Set();
  // Ejections asked while writes run: done once the queue is empty and the engine let the Lunii go.
  const ejectWaits = new Set();
  const ejectChecks = new Set();
  // Quiet reads leave mutations available; eject drains them before unmounting.
  // Their results are dropped when anything newer started since (generation).
  const rereads = new Set();
  const quietReads = new Map();
  const generations = new Map();
  const generation = id => generations.get(id) ?? 0;
  const supersede = id => { generations.set(id, generation(id) + 1); };
  const writing = new Set();
  let polling;
  let catalogueTimer = null;
  let catalogueDirty = false;
  const publish = patch => { state = { ...state, ...(Object.hasOwn(patch, 'error') ? { errorQueueEntryId: null } : {}), ...patch }; for (const listener of listeners) listener(); };
  const update = (id, patch) => publish({ luniiDevices: state.luniiDevices.map(d => d.id === id ? { ...d, ...patch } : d) });
  const persist = (field, key, value) => { settings.write(key, String(value)); publish({ [field]: value }); };
  const selectDevice = id => { if (state.activeLuniiId !== id) persist('activeLuniiId', KEYS.ACTIVE_LUNII_ID, id); if (state.selection.side === 'lunii') publish({ selection: sideSelection('lunii', []) }); };
  const settled = id => !requests.has(id) && !writing.has(id) && !ejecting.has(id);
  // Runs the quiet read queued while the device was busy with something else.
  function flushReread(id) {
    if (ejecting.has(id) || state.luniiDevices.some(d => d.id === id && ['disconnected', 'ejected'].includes(d.state))) { rereads.delete(id); return; }
    if (rereads.has(id) && !stopped && settled(id) && !quietReads.has(id)) { rereads.delete(id); void quietInspect(id); }
  }
  async function inspect(id, open = false) {
    if (requests.has(id) || writing.has(id) || ejecting.has(id)) return;
    const token = {};
    requests.set(id, token);
    supersede(id);
    update(id, { state: 'opening' });
    try {
      const detail = await api[open ? 'open' : 'inspect'](id);
      if (!stopped && requests.get(id) === token) { update(id, { ...detail, inspected: true }); if (!state.mutationError) publish({ error: null }); }
    } catch (error) {
      if (!stopped && requests.get(id) === token) {
        update(id, { state: open ? 'detected' : 'readOnly', inspected: false });
        publish({ error });
      }
    } finally { if (requests.get(id) === token) requests.delete(id); flushReread(id); void settleEject(id); }
  }
  // Keeps the displayed list and state until the new detail arrives; a failure is silent.
  async function quietInspect(id) {
    if (!settled(id) || quietReads.has(id)) { rereads.add(id); return; }
    const token = {};
    const born = generation(id);
    token.finished = new Promise(resolve => { token.finish = resolve; });
    quietReads.set(id, token);
    try {
      const detail = await api.inspect(id, { readOnly: true });
      if (!stopped && quietReads.get(id) === token && generation(id) === born && state.luniiDevices.some(d => d.id === id && d.state !== 'disconnected')) {
        update(id, { ...detail, inspected: true });
      }
    } catch { /* the list on screen stays */ }
    finally { if (quietReads.get(id) === token) quietReads.delete(id); token.finish(); flushReread(id); }
  }
  // Leading read preserves prompt trash feedback. Continuous events share one
  // trailing read per second, even when the preceding read already ended.
  function scheduleCatalogueLinks() {
    if (catalogueTimer !== null) { catalogueDirty = true; return; }
    refreshCatalogueLinks();
    catalogueTimer = timers.setTimeout(() => {
      catalogueTimer = null;
      if (catalogueDirty && !stopped) { catalogueDirty = false; scheduleCatalogueLinks(); }
    }, 1000);
  }
  function refreshCatalogueLinks() {
    for (const device of state.luniiDevices) {
      if (device.inspected && !['disconnected', 'ejected'].includes(device.state)) void quietInspect(device.id);
    }
  }
  async function drainQuietRead(id) {
    const read = quietReads.get(id);
    if (!read) return;
    let timeout;
    try {
      await Promise.race([read.finished, new Promise(resolve => {
        timeout = timers.setTimeout(() => {
          if (quietReads.get(id) === read) quietReads.delete(id);
          resolve();
        }, 3000);
      })]);
    } finally { timers.clearTimeout(timeout); }
  }
  function reconcile(inventory) {
    if (stopped) return;
    const previous = state.luniiDevices;
    const ids = new Set(inventory.map(d => d.id));
    const refresh = [];
    const quiet = new Set();
    const next = inventory.map(summary => {
      const old = previous.find(d => d.id === summary.id);
      if (['disconnected', 'ejected'].includes(summary.state) && old?.state !== summary.state) { queue.disconnect(summary.id); ejectWaits.delete(summary.id); }
      if (departures.has(summary.id)) { timers.clearTimeout(departures.get(summary.id)); departures.delete(summary.id); }
      const fresh = !old || old.state === 'disconnected';
      const coldRead = summary.state === 'ready' && !summary.busy && (fresh || (!old.inspected && old.state !== 'opening') || old.busy || old.state === 'detected' || old.state === 'ejected');
      // D43: an official cover was kept since the last read; reread without hiding the list.
      const coversRead = !coldRead && summary.state === 'ready' && !summary.busy && !!old?.inspected && summary.covers !== undefined && old.covers !== undefined && summary.covers !== old.covers;
      const needsRead = coldRead || coversRead;
      // A cover kept while the first read is still running: read again once it ends.
      if (!coldRead && !coversRead && summary.state === 'ready' && !summary.busy && summary.covers !== undefined && old?.covers !== undefined && summary.covers !== old.covers && (requests.has(summary.id) || writing.has(summary.id) || ejecting.has(summary.id))) rereads.add(summary.id);
      if (needsRead && !ejecting.has(summary.id) && !writing.has(summary.id)) { refresh.push(summary.id); if (coversRead) quiet.add(summary.id); }
      return { stories: [], orphans: [], banner: [], ...old, ...summary, ejectPending: ejectWaits.has(summary.id), busy: summary.busy || ejecting.has(summary.id) || writing.has(summary.id), state: summary.state === 'ready' && old && (!coldRead || ejecting.has(summary.id) || writing.has(summary.id)) ? old.state : summary.state };
    });
    for (const old of previous.filter(d => !ids.has(d.id))) {
      requests.delete(old.id);
      rereads.delete(old.id);
      quietReads.delete(old.id);
      supersede(old.id);
      if (old.state === 'ejected') {
        // D38: an ejected device keeps its "you can unplug" screen even once it left the inventory.
        if (!inventory.some(d => !previous.some(p => p.id === d.id))) next.push({ ...old, gone: true });
        continue;
      }
      if (old.state !== 'disconnected') queue.disconnect(old.id);
      // Unplugged while its ejection waited: nothing left to eject, and a replug never ejects.
      ejectWaits.delete(old.id);
      next.push({ ...old, state: 'disconnected', busy: false, ejectPending: false });
      if (!departures.has(old.id)) departures.set(old.id, timers.setTimeout(() => {
        departures.delete(old.id);
        if (stopped) return;
        publish({ luniiDevices: state.luniiDevices.filter(d => d.id !== old.id) });
        if (state.activeLuniiId === old.id) selectDevice(state.luniiDevices[0]?.id ?? null);
      }, 4000));
    }
    publish({ luniiDevices: next });
    // The engine let a stopped Lunii go: ejecting it works again, the advice says so.
    if (state.error?.held && inventory.some(d => d.id === state.error.deviceId && !d.busy)) publish({ error: { ...state.error, held: false } });
    for (const summary of inventory) if (ejectWaits.has(summary.id) && !summary.busy) void settleEject(summary.id);
    if (!next.some(d => d.id === state.activeLuniiId)) selectDevice(next[0]?.id ?? null);
    const added = previous.length ? next.find(d => !previous.some(p => p.id === d.id)) : null;
    if (added) selectDevice(added.id);
    if (!next.some(d => d.id === state.activeLuniiId && ['ready', 'readOnly', 'damaged'].includes(d.state)) && state.selection.side === 'lunii') publish({ selection: sideSelection('lunii', []) });
    for (const id of refresh) void (quiet.has(id) ? quietInspect(id) : inspect(id));
  }
  async function poll() {
    if (polling || stopped) return;
    const session = watchSession;
    const token = {};
    polling = token;
    try { const inventory = await api.list(); if (!stopped && watchSession === session) reconcile(inventory); }
    catch (error) { if (!stopped && watchSession === session) publish({ error }); }
    finally { if (polling === token) polling = null; }
  }
  function acceptMutationDevice(id, detail) {
    if (!state.luniiDevices.some(d => d.id === id && d.state !== 'disconnected')) return;
    update(id, { ...detail, busy: writing.has(id), inspected: true });
    if (state.selection.side === 'lunii' && state.activeLuniiId === id) {
      const remaining = new Set(luniiRows(detail).map(s => s.key));
      publish({ selection: sideSelection('lunii', state.selection.ids.filter(key => remaining.has(key))) });
    }
  }
  const pause = ms => new Promise(resolve => timers.setTimeout(resolve, ms));
  const deviceError = () => ({ code: 'STORYTELLER_DEVICE_BUSY', params: {}, deviceFault: true });
  const unresponsive = () => ({ code: 'STORYTELLER_DEVICE_UNRESPONSIVE', params: {}, deviceFault: true });
  async function waitReleased(id, sleep = pause) {
    if (!api.list) return; // Synchronous-only injected facades have no native reservation.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const inventory = await api.list();
      if (!inventory.some(d => d.id === id && d.busy)) return;
      await sleep(100);
    }
    throw deviceError();
  }
  // Silence watch of one write: after LUNII_SILENCE_NOTICE_MS the panel says the Lunii does not
  // answer (nothing stops); at the bound the write fails as a fault of the Lunii. Timers cover an
  // IPC that never answers; `arm` restarts the silence on each sign of life.
  function silenceWatch(id) {
    let notice, expiry, deadline, fail;
    const expired = new Promise((_, reject) => { fail = reject; });
    expired.catch(() => {});
    const quiet = value => { if (state.luniiDevices.some(d => d.id === id && !!d.unresponsive !== value)) update(id, { unresponsive: value }); };
    return {
      expired, quiet,
      arm(limit, noticeAt = LUNII_SILENCE_NOTICE_MS) {
        timers.clearTimeout(notice); timers.clearTimeout(expiry); quiet(false);
        notice = timers.setTimeout(() => quiet(true), noticeAt);
        expiry = timers.setTimeout(() => fail(unresponsive()), limit);
      },
      // A bound that activity does not push back (a cancellation that never ends).
      deadline(limit) { if (deadline === undefined) deadline = timers.setTimeout(() => fail(unresponsive()), limit); },
      stop() { timers.clearTimeout(notice); timers.clearTimeout(expiry); timers.clearTimeout(deadline); quiet(false); },
    };
  }
  /** A synchronous command (remove, reorder, hide, rename…): its answer after the bound is dropped. */
  async function bounded(id, work, limit = LUNII_COMMAND_LIMIT_MS) {
    const watch = silenceWatch(id);
    // The notice moves with the bound: a long removal that is still working must not tell the
    // user that the Lunii does not answer (an invitation to unplug it in the middle of a write).
    watch.arm(limit, LUNII_SILENCE_NOTICE_MS + Math.max(0, limit - LUNII_COMMAND_LIMIT_MS));
    try { return await Promise.race([work, watch.expired]); } finally { watch.stop(); }
  }
  async function waitOperation(id, receipt, knownSnapshot = () => null) {
    if (!receipt?.operationId || !api.getOperation) return null;
    // Busy is only a reservation, never evidence of an operation's success.
    if (sendTerminal(knownSnapshot(receipt.operationId))) return knownSnapshot(receipt.operationId);
    // Any new progress, step or status is a sign of life; no total bound, so a slow but living
    // copy is never cut. Silence and cancelling are also counted by poll, for fake timers.
    const watch = silenceWatch(id);
    watch.arm(LUNII_OPERATION_SILENCE_MS);
    let mark, silent = 0, cancelling = null;
    try {
      for (;;) {
        const known = knownSnapshot(receipt.operationId);
        if (sendTerminal(known)) return known;
        // Events are authoritative while available; IPC is a recovery fallback.
        const snapshot = await Promise.race([api.getOperation(receipt.operationId), watch.expired]);
        if (sendTerminal(snapshot)) return snapshot;
        const latest = [knownSnapshot(receipt.operationId), snapshot].filter(Boolean).sort((a, b) => (b.sequence ?? -1) - (a.sequence ?? -1))[0];
        const sign = JSON.stringify([latest?.sequence, latest?.status, latest?.phase, latest?.result]);
        if (sign !== mark) { mark = sign; silent = 0; watch.arm(LUNII_OPERATION_SILENCE_MS); }
        if (latest?.status === 'cancelling' && cancelling === null) { cancelling = 0; watch.deadline(LUNII_CANCEL_LIMIT_MS); }
        await Promise.race([pause(LUNII_POLL_MS), watch.expired]);
        silent += LUNII_POLL_MS;
        if (cancelling !== null) cancelling += LUNII_POLL_MS;
        if (silent >= LUNII_SILENCE_NOTICE_MS) watch.quiet(true);
        if (silent >= LUNII_OPERATION_SILENCE_MS || cancelling >= LUNII_CANCEL_LIMIT_MS) throw unresponsive();
      }
    } finally { watch.stop(); }
  }

  async function reread(id) {
    if (state.luniiDevices.find(d => d.id === id)?.state === 'disconnected') return;
    for (let attempt = 0; ; attempt += 1) {
      try { acceptMutationDevice(id, await api.inspect(id)); rereads.delete(id); return; }
      catch (error) { if (attempt >= 4) { update(id, { state: 'readOnly', inspected: false }); throw error; } await pause(200); }
    }
  }
  const queue = createLuniiQueue({
    session: luniiQueueSession(api),
    changed: luniiQueue => publish({ luniiQueue }),
    acquire(id) { writing.add(id); supersede(id); update(id, { busy: true, queueActive: true }); publish({ error: null, mutationError: false }); },
    release(id) { writing.delete(id); update(id, { busy: false, sending: false, queueActive: false, pendingKeys: [] }); flushReread(id); void settleEject(id); },
    async execute(id, entry, payload) {
      const { method = entry.kind, args = [] } = payload;
      const showingKey = method === 'hide' && args[1] === false ? args[0] : null;
      update(id, { busy: true, sending: method === 'send', pendingKeys: entry.keys });
      publish({ conflictKey: null, conflictDeviceId: null });
      let result, failure;
      let reportOnly = false;
      try {
        if (method === 'send') result = await bounded(id, payload.run(state.luniiDevices.find(device => device.id === id), entry.id));
        else if (method === 'repatriate') {
          const requestId = crypto.randomUUID();
          rememberRepatriationTitle(requestId, entry.title || null);
          const workspace = await payload.workspace;
          result = await bounded(id, api.repatriate(id, entry.keys[0], requestId, workspace, payload.archiveName));
        } else if (method === 'reorder' && !Array.isArray(args[0])) {
          const device = state.luniiDevices.find(device => device.id === id);
          const { rowKey, index, delta } = args[0];
          const target = rowKey == null ? device.stories.length : device.stories.findIndex(story => story.key === rowKey);
          const order = delta == null ? reorderedKeys(device.stories, entry.keys, target < 0 ? Math.min(index, device.stories.length) : target)
            : steppedKeys(device.stories, entry.keys, delta);
          result = await bounded(id, api.reorder(id, order));
        } else if (method === 'orphan') result = await bounded(id, api.orphan(args[0]));
        else result = await bounded(id, api[method](id, ...(method === 'remove' ? [entry.keys] : args)),
          LUNII_COMMAND_LIMIT_MS + (PER_STORY_COMMANDS.includes(method) ? entry.keys.length * LUNII_COMMAND_PER_STORY_MS : 0));
        const snapshot = await waitOperation(id, method === 'send' ? result?.receipt : result, payload.snapshot);
        if (snapshot) {
          if (method === 'send' && result?.context?.queueEntryId === entry.id) {
            const interrupted = queueSendInterruption(result.context, snapshot);
            if (interrupted) entry.sendInterruption = { ...sendReport(result.context, snapshot, state.luniiDevices), deviceId: id };
          }
          const items = snapshot.result?.stories ?? [];
          const broken = items.find(item => item.deviceFault === true);
          const failed = items.find(item => ['failed', 'refused', 'interrupted', 'notStarted'].includes(item.step));
          if (broken || failed || ['failed', 'cancelled'].includes(snapshot.status)) {
            reportOnly = ['send', 'repatriate'].includes(method);
            throw { ...(broken?.reason ?? failed?.reason ?? snapshot.error ?? { code: 'STORYTELLER_WRITE_FAILED', params: {} }), deviceFault: !!broken || snapshot.error?.deviceFault === true };
          }
        }
        if (method !== 'send' && method !== 'repatriate' && result) acceptMutationDevice(id, result.device ?? result);
        const repair = result?.outcomes?.find(o => o.status === 'repaired' || o.status === 'repairedNotDurable');
        if (repair) publish({ notice: { key: 'catalogue:lunii.repairResult', params: { kept: repair.kept, removed: repair.removed.length + (repair.truncated ? 1 : 0), orphans: result.device.orphans.length } } });
        const warning = result?.outcomes?.some(o => !['complete', 'repaired'].includes(o.status));
        if (warning) throw { code: method.startsWith('hide') ? 'STORYTELLER_STORY_PARKING_FAILED' : 'STORYTELLER_WRITE_FAILED', params: {} };
      } catch (error) { failure = error; }
      // Even a rejected command can have committed part of its write.
      let released = false;
      try { await waitReleased(id); released = true; } catch (error) {
        failure = { ...(failure ?? error), deviceFault: true };
        // Stopped and still reserved by the engine: ejecting cannot end, the advice is to unplug.
        if (failure.code === 'STORYTELLER_DEVICE_UNRESPONSIVE') failure = { ...failure, held: true, deviceId: id };
      }
      if (released) {
        try { await reread(id); } catch (error) { failure = { ...(failure ?? error), deviceFault: true }; }
      } else update(id, { state: 'readOnly', inspected: false });
      if (method === 'send') payload.settled?.(result);
      if (failure) {
        const error = failure;
        const envelope = error.userMessage ?? error;
        const conflict = showingKey !== null && envelope.code === 'STORYTELLER_STORY_DUPLICATE' && envelope.params?.position == null;
        const current = state.luniiDevices.find(d => d.id === id);
        const key = conflict ? current?.orphans.find(o => !o.parked && o.key.toLowerCase() === showingKey.replaceAll('-', '').slice(-8).toLowerCase())?.key : null;
        if (!reportOnly || failure.deviceFault) publish({ error, errorQueueEntryId: entry.sendInterruption ? entry.id : null, mutationError: true, conflictKey: key ?? null, conflictDeviceId: key ? id : null });

        throw failure;
      }
      return method === 'send' ? result?.context : result;
    },
  });
  state = { ...state, luniiQueue: queue.getSnapshot() };
  async function ejectNow(id) {
    if (state.luniiDevices.find(d => d.id === id)?.busy || writing.has(id) || requests.has(id)) return;
    ejecting.add(id);
    supersede(id);
    update(id, { busy: true });
    rereads.delete(id);
    try { await drainQuietRead(id); if (stopped) return; await api.eject(id); update(id, { state: 'ejected', busy: false }); publish({ ...(state.selection.side === 'lunii' ? { selection: sideSelection('lunii', []) } : {}), error: null }); }
    catch (error) { update(id, { busy: false }); publish({ error }); }
    finally { ejecting.delete(id); flushReread(id); }
  }
  /**
   * « Attendre la fin » : the Lunii is ejected once its queue is empty (gestures made meanwhile
   * included) and the engine has released it. After a stopped Lunii the native reservation can
   * outlive the queue: the wait goes on until the inventory shows it free, or until cancelled.
   */
  function ejectWhenIdle(id) {
    if (!state.luniiDevices.some(d => d.id === id && !['disconnected', 'ejected'].includes(d.state))) return;
    ejectWaits.add(id);
    update(id, { ejectPending: true });
    void settleEject(id);
  }
  function dropEjectWait(id) { if (ejectWaits.delete(id)) update(id, { ejectPending: false }); }
  async function settleEject(id) {
    const blocked = () => !ejectWaits.has(id) || queue.active(id) || writing.has(id) || requests.has(id) || ejecting.has(id);
    if (blocked() || ejectChecks.has(id)) return;
    ejectChecks.add(id);
    try {
      const inventory = api.list ? await api.list() : [];
      // Still reserved: the next inventory without `busy` tries again (reconcile).
      if (blocked() || inventory.some(d => d.id === id && d.busy)) return;
      ejectWaits.delete(id);
      update(id, { ejectPending: false, busy: false });
      await ejectNow(id);
    } catch { /* the inventory will tell again */ }
    finally { ejectChecks.delete(id); }
  }
  function refusalFor(id, method) {
    return luniiWriteRefusal(state.luniiDevices.find(d => d.id === id), method) || (requests.has(id) ? 'STORYTELLER_DEVICE_BUSY' : null);
  }
  // `titles` (by key) are the names the user sees, decorated by the caller; the raw device only backs them up.
  function mutate(id, method, args = [], keys = [], titles = {}) {
    const rowTitle = (story, key = story?.key) => (method === 'nameStory' ? args[1]?.trim() : titles[key]?.trim()) || story?.title?.trim() || '';
    const refusal = refusalFor(id, method);
    if (refusal) { publish({ error: { code: refusal, params: {} }, mutationError: true }); return Promise.resolve(null); }
    const device = state.luniiDevices.find(d => d.id === id);
    if (method === 'hideMany' || method === 'repatriateMany') {
      // Capture settings and names now, including while another write owns the runner.
      const workspace = method === 'repatriateMany' ? resolveWorkspace() : null;
      workspace?.catch(() => {});
      const jobs = keys.map(key => {
        const story = device.stories?.find(story => story.key === key);
        const title = rowTitle(story, key);
        const archiveName = title && story?.ageMin != null ? generateConventionName({ title, minAge: story.ageMin, maxAge: story.ageMax }) : title;
        return queue.enqueue(id, { kind: method === 'hideMany' ? 'hide' : 'repatriate', keys: [key], title, args: [key, args[0]], workspace, archiveName, deviceName: device.name ?? null }).finished;
      });
      return Promise.all(jobs).then(results => results.at(-1) ?? null);
    }
    const actualKeys = keys.length ? keys : method === 'remove' ? args[0] : ['hide', 'nameStory'].includes(method) ? [args[0]] : [];
    return queue.enqueue(id, { kind: method, args: structuredClone(args), keys: actualKeys, deviceName: device.name ?? null, title: actualKeys.map(key => rowTitle(luniiRows(device).find(s => s.key === key), key)).filter(Boolean).join(', ') || (method === 'rename' ? args[0] : device.name || '') }).finished;
  }
  function enqueueSend(id, context, run, settled, snapshot) {
    const refusal = refusalFor(id, 'send');
    if (refusal) { publish({ error: { code: refusal, params: {} }, mutationError: true }); return null; }
    return queue.enqueue(id, { kind: 'send', deviceName: state.luniiDevices.find(d => d.id === id)?.name ?? null, ...context, run, settled, snapshot });
  }
  // A send holds the device like a write: no automatic read until it settles.
  function beginSend(id) {
    const device = state.luniiDevices.find(d => d.id === id);
    const refusal = luniiWriteRefusal(device, 'send');
    if (refusal || writing.has(id) || requests.has(id)) return refusal || 'STORYTELLER_DEVICE_BUSY';
    writing.add(id);
    supersede(id);
    update(id, { busy: true, sending: true });
    publish({ error: null, mutationError: false });
    return null;
  }
  // Waits for the engine to release the device, then reads the final list once.
  async function endSend(id, pause = ms => new Promise(resolve => timers.setTimeout(resolve, ms))) {
    if (queue.active(id)) return;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const inventory = await api.list();
        if (!inventory.some(d => d.id === id && d.busy)) break;
        await pause(100);
      }
      let detail;
      // The engine may still hold the device right after the send: retry, bounded.
      for (let attempt = 0; ; attempt += 1) {
        try { detail = await api.inspect(id); break; } catch (error) {
          if (attempt >= 4) throw error;
          await pause(200);
        }
      }
      acceptMutationDevice(id, detail);
    } catch { update(id, { inspected: false }); }
    finally { writing.delete(id); update(id, { busy: false, sending: false }); flushReread(id); }
  }
  return {
    mutate, beginSend, endSend, enqueueSend,
    cancel: id => queue.cancel(id), queued: () => queue.queued(), cancelQueued: deviceId => queue.cancelQueued(deviceId),
    ejectWhenIdle, cancelEjectWait: dropEjectWait,
    getQueueReport: () => queue.getSnapshot(),
    dismissQueueReport: (deviceId, run) => queue.dismissReport(deviceId, run),
    reportError: error => publish({ error, mutationError: true }),
    dismissNotice: () => publish({ notice: null }),
    dismissError: () => publish({ error: null, conflictKey: null, conflictDeviceId: null, mutationError: false }),
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    reconcile, poll, inspect, selectDevice,
    select: (side, ids) => publish({ selection: sideSelection(side, ids) }),
    collapse: value => {
      if (value && state.luniiDevices.some(d => d.state === 'ejected' && d.gone)) {
        publish({ luniiDevices: state.luniiDevices.filter(d => !(d.state === 'ejected' && d.gone)) });
        if (!state.luniiDevices.some(d => d.id === state.activeLuniiId)) selectDevice(state.luniiDevices[0]?.id ?? null);
      }
      persist('luniiPanelCollapsed', KEYS.LUNII_PANEL_COLLAPSED, value);
    },
    resizeFiche: value => persist('fichePanelWidth', KEYS.CATALOGUE_FICHE_WIDTH, Math.max(1, Math.round(value))),
    resize: value => persist('luniiPanelWidth', KEYS.LUNII_PANEL_WIDTH, Math.max(LUNII_PANEL_WIDTH.min, Math.round(value))),
    eject: ejectNow,
    start() {
      stopped = false;
      const session = {};
      watchSession = session;
      void poll();
      void api.onDevicesChanged(value => { if (watchSession === session) reconcile(value); }).then(stop => { if (stopped || watchSession !== session) stop(); else stopListening = stop; }).catch(error => { if (!stopped) publish({ error }); });
      if (api.onCatalogueChanged) void api.onCatalogueChanged(() => { if (watchSession === session) scheduleCatalogueLinks(); }).then(stop => { if (stopped || watchSession !== session) stop(); else stopCatalogueListening = stop; }).catch(error => { if (!stopped) publish({ error }); });
      const interval = timers.setInterval(poll, 2000);
      return () => { stopped = true; watchSession = null; polling = null; stopListening?.(); stopCatalogueListening?.(); timers.clearInterval(interval); for (const timer of departures.values()) timers.clearTimeout(timer); departures.clear(); requests.clear(); rereads.clear(); quietReads.clear(); if (catalogueTimer !== null) timers.clearTimeout(catalogueTimer); catalogueTimer = null; catalogueDirty = false; };
    },
  };
}

export function luniiWriteRefusal(device, method) {
  if (!device || ['disconnected', 'ejected'].includes(device.state)) return 'STORYTELLER_DEVICE_GONE';
  if ((device.busy && !device.queueActive) || device.state === 'opening') return 'STORYTELLER_DEVICE_BUSY';
  if (method === 'repatriateMany') return null;
  if (device.readOnlyReason === 'volume') return 'STORYTELLER_VOLUME_READ_ONLY';
  if (device.state === 'readOnly' || device.banner?.includes('readOnly')) return 'STORYTELLER_READ_ONLY';
  if (device.state === 'damaged' && method !== 'repair') return 'STORYTELLER_PLAYLIST_DAMAGED';
  if (!['ready', 'damaged'].includes(device.state)) return 'STORYTELLER_READ_ONLY';
  return null;
}

/** Target is an insertion boundary in the original device order, starting at zero. */
export function reorderedKeys(stories, selected, target) {
  const ids = new Set(selected);
  const moving = stories.filter(s => ids.has(s.key));
  const rest = stories.filter(s => !ids.has(s.key));
  const at = stories.slice(0, target).filter(s => !ids.has(s.key)).length;
  rest.splice(at, 0, ...moving);
  return rest.map(s => s.key);
}
export function luniiSelection(rows, selected, key, event = {}, anchor = key) {
  if (event.shiftKey) {
    const a = rows.findIndex(s => s.key === anchor), b = rows.findIndex(s => s.key === key);
    return rows.slice(Math.max(0, Math.min(a, b)), Math.max(a, b) + 1).map(s => s.key);
  }
  if (event.ctrlKey || event.metaKey) return selected.includes(key) ? selected.filter(id => id !== key) : [...selected, key];
  return [key];
}
export function luniiSelectAll(rows) { return rows.filter(s => !s.orphan && s.kind !== 'official').map(s => s.key); }

/** Match only independent full identities; a suffix never invents an identity.
 *  An orphan without a title takes the one of the catalogue card holding its UUID. */
export function withKnownOrphans(devices, cards) {
  return devices.map(device => ({ ...device, orphans: device.orphans.map(story => {
    const name = story.key.replace(/^parked:/, '');
    const candidates = new Set([story.knownUuid, ...cards.flatMap(card => card.uuids ?? [])].filter(id => typeof id === 'string' && id.replaceAll('-', '').slice(-8).toUpperCase() === name));
    // The device's own candidates contradict each other: never complete from the catalogue.
    if (story.identityConflict) return { ...story, knownUuid: null };
    const knownUuid = candidates.size === 1 ? [...candidates][0] : null;
    const card = knownUuid && !story.title ? cards.find(c => (c.uuids ?? []).includes(knownUuid)) : null;
    if (!card) return { ...story, knownUuid };
    return { ...story, knownUuid, title: cardTitle(card),
      ...(story.coverPath || story.catalogueFicheId ? {} : { catalogueFicheId: card.id, catalogueCoverSignature: card.coverSignature ?? null }) };
  }) }));
}
/** Orphans that « Tout remettre dans la liste » puts back: complete, in `.content`, with a full UUID. */
export function restorableOrphans(device) {
  return (device?.orphans ?? []).filter(s => !s.parked && !s.duplicateOfListed && s.complete && typeof s.knownUuid === 'string');
}

/** Move each selected block across one adjacent unselected row. */
export function steppedKeys(stories, selected, delta) {
  const ids = new Set(selected), order = stories.map(s => s.key);
  const indexes = delta < 0 ? order.map((_, i) => i) : order.map((_, i) => i).reverse();
  for (const index of indexes) {
    const other = index + delta;
    if (ids.has(order[index]) && other >= 0 && other < order.length && !ids.has(order[other])) {
      [order[index], order[other]] = [order[other], order[index]];
    }
  }
  return order;
}

/**
 * Stories and orphans linked to a catalogue card carry the card's name (same function as the card),
 * so panel, banner, confirmations, queue and bilan name them alike. A story the device does not
 * know (`unknown`) keeps its own name: it stays nameable, and a renaming shows.
 */
export function withCardTitles(devices, cards) {
  const byId = new Map((cards ?? []).map(card => [card.id, card]));
  if (!byId.size) return devices;
  const named = story => {
    const card = story.catalogueFicheId && story.kind !== 'unknown' ? byId.get(story.catalogueFicheId) : null;
    if (!card) return story;
    // A card without a title leaves the device's own name: the same name everywhere.
    const title = cardTitle(card)?.trim();
    return !title || title === story.title ? story : { ...story, title };
  };
  return devices.map(device => ({ ...device, stories: (device.stories ?? []).map(named), orphans: (device.orphans ?? []).map(named) }));
}
