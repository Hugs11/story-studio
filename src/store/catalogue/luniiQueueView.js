import { reorderedKeys, steppedKeys } from './luniiDevices.js';

// What the Lunii list shows of its waiting operations. Nothing here writes:
// every position is resolved again by the queue when the entry runs.

const waiting = entry => entry.state === 'queued';

/**
 * Order the list will have once the waiting moves are done, resolved like
 * their execution (neighbour key first, index only if the neighbour left).
 * A running move is left out: its result replaces the list when it lands.
 */
export function queuedOrder(device, entries = []) {
  let stories = device?.stories ?? [];
  let moved = false;
  for (const entry of entries) {
    const intent = entry.args?.[0];
    if (entry.kind !== 'reorder' || !waiting(entry) || !intent || Array.isArray(intent)) continue;
    const { rowKey, index, delta } = intent;
    let order;
    if (delta != null) order = steppedKeys(stories, entry.keys, delta);
    else {
      const target = rowKey == null ? stories.length : stories.findIndex(story => story.key === rowKey);
      order = reorderedKeys(stories, entry.keys, target < 0 ? Math.min(index, stories.length) : target);
    }
    const byKey = new Map(stories.map(story => [story.key, story]));
    stories = order.map(key => byKey.get(key));
    moved = true;
  }
  return moved ? { ...device, stories } : device;
}

/** Devices as the panel shows them: waiting moves already applied. */
export function withQueuedOrder(devices, queues = {}) {
  return devices.map(device => queuedOrder(device, queues?.[device.id]));
}

function rowAction(entry) {
  switch (entry.kind) {
    case 'remove': return 'remove';
    case 'orphan': return entry.args?.[0]?.restore ? 'putBack' : 'delete';
    case 'restoreOrphans': return 'putBack';
    case 'hide': return entry.args?.[1] === false ? 'show' : 'hide';
    case 'nameStory': return 'name';
    case 'reorder': return 'move';
    case 'repatriate': return 'repatriate';
    default: return null;
  }
}

/** Waiting gestures per story key, in queue order: `{ entryId, action }`. */
export function queuedMarks(entries = []) {
  const marks = new Map();
  for (const entry of entries) {
    const action = waiting(entry) ? rowAction(entry) : null;
    if (!action) continue;
    for (const key of entry.keys) marks.set(key, [...(marks.get(key) ?? []), { entryId: entry.id, action }]);
  }
  return marks;
}

/** A story about to leave the Lunii: shown struck through until it does. */
export const removalPending = marks => (marks ?? []).some(mark => mark.action === 'remove' || mark.action === 'delete');

/** Waiting gestures on the whole device (name, repair, restored list). */
export function queuedDeviceMarks(entries = []) {
  return entries.filter(entry => waiting(entry) && ['rename', 'repair', 'restore'].includes(entry.kind))
    .map(entry => ({ entryId: entry.id, action: entry.kind, name: entry.kind === 'rename' ? entry.args?.[0] ?? '' : null }));
}

/** A repair waits or runs on this device: a second one would only repeat it. */
export const repairPending = (entries = []) => entries.some(entry => entry.kind === 'repair' && ['queued', 'running'].includes(entry.state));

/** Number of operations still waiting their turn on this device. */
export const queuedCount = (entries = []) => entries.filter(waiting).length;

/**
 * Stories of waiting sends, at their drop place, resolved like the send itself:
 * before the remembered neighbour, at the remembered index if it left, at the
 * end when dropped at the end. A send that started but whose copy is not
 * tracked yet (`live` false) stays shown, without its cancel cross.
 */
export function queuedSendRows(device, entries = [], live = false) {
  const stories = device?.stories ?? [];
  return entries.filter(entry => entry.kind === 'send' && (entry.state === 'queued' || (entry.state === 'running' && !live))).flatMap(entry => {
    const found = entry.rowKey == null ? -1 : stories.findIndex(story => story.key === entry.rowKey);
    const index = entry.rowKey == null ? stories.length : found >= 0 ? found : Math.min(entry.dropIndex ?? stories.length, stories.length);
    return (entry.items ?? []).map(item => ({
      key: `queued:${entry.id}:${item.exemplarId}`, index, origin: index, position: null,
      title: item.title, ficheId: item.ficheId, coverSignature: item.coverSignature,
      entryId: entry.id, count: entry.items.length, queued: true, starting: entry.state === 'running',
    }));
  });
}

/**
 * End-of-queue reports, one per finished run that did not do everything:
 * failed entries with their reason, entries never started (and why the queue
 * stopped), removals cancelled because their repatriation failed. A clean run
 * has no report (each send keeps its own bilan); a closed report never returns.
 */
export function queueReports(queues = {}) {
  const reports = [];
  for (const [deviceId, entries] of Object.entries(queues ?? {})) {
    const runs = new Map();
    for (const entry of entries) if (entry.run) runs.set(entry.run, [...(runs.get(entry.run) ?? []), entry]);
    for (const [run, list] of runs) {
      if (list.some(entry => entry.reported || entry.state === 'queued' || entry.state === 'running')) continue;
      const failed = list.filter(entry => entry.state === 'failed');
      const notStarted = list.filter(entry => entry.state === 'notStarted');
      const titleOf = key => list.find(entry => entry.kind === 'repatriate' && entry.keys.includes(key))?.title || null;
      const excluded = list.flatMap(entry => entry.reason?.excluded ?? []).map(item => ({ key: item.key, title: titleOf(item.key) }));
      if (!failed.length && !notStarted.length && !excluded.length) continue;
      reports.push({
        deviceId, run, deviceName: list.find(entry => entry.deviceName)?.deviceName ?? null,
        done: list.filter(entry => entry.state === 'done').length, failed, notStarted, excluded,
        stop: notStarted[0]?.reason ?? null,
      });
    }
  }
  return reports;
}

/** A Lunii that stopped and is still held by the engine: ejecting cannot end, the advice is to unplug it. */
export const heldByEngine = error => error?.held === true && error.code === 'STORYTELLER_DEVICE_UNRESPONSIVE';
