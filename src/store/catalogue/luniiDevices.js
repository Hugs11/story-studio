import { KEYS, read, write } from '../persistentSettings.js';
import { rememberRepatriationTitle } from './operationView.js';

export const LUNII_PANEL_WIDTH = Object.freeze({ min: 330, initial: 330 });

/** Device order is authoritative. Parked orphans remain orphans, after the list. */
export function luniiRows(device) {
  let position = 0;
  return [
    ...(device?.stories ?? []).map(story => ({ ...story, orphan: false, position: story.hidden ? null : ++position })),
    ...(device?.orphans ?? []).map(story => ({ ...story, orphan: true, position: null })),
  ];
}
export function sideSelection(side, ids) { return { side, ids: [...new Set(ids)] }; }

/** IPC stays injectable; one explicit mutation at a time per device. */
export function createLuniiDevices(api, settings = { read, write }, timers = globalThis) {
  let state = {
    luniiDevices: [], activeLuniiId: settings.read(KEYS.ACTIVE_LUNII_ID),
    luniiPanelCollapsed: settings.read(KEYS.LUNII_PANEL_COLLAPSED) === 'true',
    luniiPanelWidth: Math.max(LUNII_PANEL_WIDTH.min, Number(settings.read(KEYS.LUNII_PANEL_WIDTH)) || LUNII_PANEL_WIDTH.initial),
    fichePanelWidth: Math.max(1, Number(settings.read(KEYS.CATALOGUE_FICHE_WIDTH)) || 420),
    selection: sideSelection('catalogue', []), error: null, notice: null, conflictKey: null, conflictDeviceId: null, mutationError: false,
  };
  const listeners = new Set();
  const requests = new Map();
  const departures = new Map();
  let stopped = false;
  let stopListening;
  let stopCatalogueListening;
  let watchSession;
  const ejecting = new Set();
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
  const publish = patch => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
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
    } finally { if (requests.get(id) === token) requests.delete(id); flushReread(id); }
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
      if (departures.has(summary.id)) { timers.clearTimeout(departures.get(summary.id)); departures.delete(summary.id); }
      const fresh = !old || old.state === 'disconnected';
      const coldRead = summary.state === 'ready' && !summary.busy && (fresh || (!old.inspected && old.state !== 'opening') || old.busy || old.state === 'detected' || old.state === 'ejected');
      // D43: an official cover was kept since the last read; reread without hiding the list.
      const coversRead = !coldRead && summary.state === 'ready' && !summary.busy && !!old?.inspected && summary.covers !== undefined && old.covers !== undefined && summary.covers !== old.covers;
      const needsRead = coldRead || coversRead;
      // A cover kept while the first read is still running: read again once it ends.
      if (!coldRead && !coversRead && summary.state === 'ready' && !summary.busy && summary.covers !== undefined && old?.covers !== undefined && summary.covers !== old.covers && (requests.has(summary.id) || writing.has(summary.id) || ejecting.has(summary.id))) rereads.add(summary.id);
      if (needsRead && !ejecting.has(summary.id) && !writing.has(summary.id)) { refresh.push(summary.id); if (coversRead) quiet.add(summary.id); }
      return { stories: [], orphans: [], banner: [], ...old, ...summary, busy: summary.busy || ejecting.has(summary.id) || writing.has(summary.id), state: summary.state === 'ready' && old && (!coldRead || ejecting.has(summary.id) || writing.has(summary.id)) ? old.state : summary.state };
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
      next.push({ ...old, state: 'disconnected', busy: false });
      if (!departures.has(old.id)) departures.set(old.id, timers.setTimeout(() => {
        departures.delete(old.id);
        if (stopped) return;
        publish({ luniiDevices: state.luniiDevices.filter(d => d.id !== old.id) });
        if (state.activeLuniiId === old.id) selectDevice(state.luniiDevices[0]?.id ?? null);
      }, 4000));
    }
    publish({ luniiDevices: next });
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
    update(id, { ...detail, inspected: true });
    if (state.selection.side === 'lunii' && state.activeLuniiId === id) {
      const remaining = new Set(luniiRows(detail).map(s => s.key));
      publish({ selection: sideSelection('lunii', state.selection.ids.filter(key => remaining.has(key))) });
    }
  }
  async function mutate(id, method, args = [], keys = []) {
    const device = state.luniiDevices.find(d => d.id === id);
    const refusal = luniiWriteRefusal(device, method);
    if (writing.has(id) || requests.has(id) || refusal) {
      publish({ error: { code: refusal || 'STORYTELLER_DEVICE_BUSY', params: {} }, mutationError: true });
      return null;
    }
    if (['hideMany', 'repatriateMany'].includes(method) && !keys.length) return null;
    writing.add(id);
    supersede(id);
    update(id, { busy: true, pendingKeys: keys });
    publish({ error: null, conflictKey: null, conflictDeviceId: null, mutationError: false });
    let showingKey = method === 'hide' && args[1] === false ? args[0] : null;
    try {
      let result;
      if (method === 'hideMany') {
        const outcomes = [];
        for (const key of keys) { if (args[0] === false) showingKey = key; result = await api.hide(id, key, args[0]); outcomes.push(...(result.outcomes ?? [])); }
        if (result) result = { ...result, outcomes };
      } else if (method === 'repatriateMany') {
        // Each receipt owns a native reservation until the operation terminates.
        // Subsequent items are launched only after the OS inventory releases it.
        for (const key of keys) {
          const requestId = globalThis.crypto.randomUUID();
          rememberRepatriationTitle(requestId, device.stories?.find(story => story.key === key)?.title?.trim() || null);
          await api.repatriate(id, key, requestId);
          while ((await api.list()).some(d => d.id === id && d.busy)) {
            await new Promise(resolve => timers.setTimeout(resolve, 250));
          }
        }
        result = await api.inspect(id);
      } else if (method === 'orphan') result = await api.orphan(args[0]);
      else result = await api[method](id, ...args);
      acceptMutationDevice(id, result?.device ?? result);
      const repair = result?.outcomes?.find(o => o.status === 'repaired' || o.status === 'repairedNotDurable');
      if (repair) publish({ notice: { key: 'catalogue:lunii.repairResult', params: { kept: repair.kept, removed: repair.removed.length + (repair.truncated ? 1 : 0), orphans: result.device.orphans.length } } });
      const warning = result?.outcomes?.some(o => !['complete', 'repaired'].includes(o.status));
      if (warning) publish({ error: { code: method.startsWith('hide') ? 'STORYTELLER_STORY_PARKING_FAILED' : 'STORYTELLER_WRITE_FAILED', params: {} }, mutationError: true });
      return result;
    } catch (error) {
      // A failed command may have committed part of a batch: never restore a UI snapshot.
      try { acceptMutationDevice(id, await api.inspect(id)); }
      catch { update(id, { state: 'readOnly', inspected: false }); }
      const envelope = error.userMessage ?? error;
      const conflict = showingKey !== null && envelope.code === 'STORYTELLER_STORY_DUPLICATE' && envelope.params?.position == null;
      const current = state.luniiDevices.find(d => d.id === id);
      const key = conflict ? current?.orphans.find(o => !o.parked && o.key.toLowerCase() === showingKey.replaceAll('-', '').slice(-8).toLowerCase())?.key : null;
      publish({ error, mutationError: true, conflictKey: key ?? null, conflictDeviceId: key ? id : null });
      return null;
    } finally {
      writing.delete(id);
      update(id, { busy: false, pendingKeys: [] });
      flushReread(id);
    }
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
    mutate, beginSend, endSend,
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
    async eject(id) {
      if (state.luniiDevices.find(d => d.id === id)?.busy || writing.has(id) || requests.has(id)) return;
      ejecting.add(id);
      supersede(id);
      update(id, { busy: true });
      rereads.delete(id);
      try { await drainQuietRead(id); if (stopped) return; await api.eject(id); update(id, { state: 'ejected', busy: false }); publish({ ...(state.selection.side === 'lunii' ? { selection: sideSelection('lunii', []) } : {}), error: null }); }
      catch (error) { update(id, { busy: false }); publish({ error }); }
      finally { ejecting.delete(id); flushReread(id); }
    },
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
  if (device.busy || device.state === 'opening') return 'STORYTELLER_DEVICE_BUSY';
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
    return { ...story, knownUuid, title: card.displayTitle ?? card.title ?? null,
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
