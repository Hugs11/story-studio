// Sending catalogue stories to a Lunii: pure rules shared by the drag, the buttons,
// the activity pill and the panel. No IPC and no rendered text here: only keys.
import { luniiRows, luniiWriteRefusal } from './luniiDevices.js';
import { cardTitle } from './entryModel.js';
import { coverAddress } from './coverAddress.js';
import { damagedLine, damagedRefusal } from './damagedMedia.js';

export const OPEN_STATES = Object.freeze(['ready', 'readOnly', 'damaged']);
const SETTLED = Object.freeze(['done', 'refused', 'failed', 'interrupted', 'notStarted']);
/** Steps of a story being sent, in the order the engine enters them (a step is skipped when it does not happen). */
export const ACTIVE_STEPS = Object.freeze(['preparing', 'generating', 'convertingSounds', 'convertingImages', 'encrypting', 'copying', 'finalizing']);
const CANCEL_CODES = Object.freeze(['STORYTELLER_SEND_CANCELLED', 'GENERATION_CANCELLED']);
const sameUuid = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** Lunii whose list is shown: the only possible destinations. */
export function openDevices(devices = []) { return devices.filter(d => OPEN_STATES.includes(d.state)); }

/** The copy sent for a card: the reference one when usable, else the first available. A copy with a damaged picture is never sent. */
export function sendableExemplar(card) {
  const exemplars = sendableExemplars(card);
  return exemplars.find(e => e.id === card.referenceExemplarId) ?? exemplars[0] ?? null;
}

/** Copies that can really leave for a Lunii (the engine refuses the others, and a damaged picture is refused anyway). */
export function sendableExemplars(card) { return (card?.exemplars ?? []).filter(e => e.available && !e.damagedMedia); }

/**
 * Why a card cannot leave although it has available copies: all of them have a damaged picture
 * (found at import). The engine's own refusal (`code`, `params`), of the copy a send would take.
 */
export function damagedCardRefusal(card) {
  const available = (card?.exemplars ?? []).filter(e => e.available);
  if (!available.length || available.some(e => !e.damagedMedia)) return null;
  const exemplar = available.find(e => e.id === card.referenceExemplarId) ?? available[0];
  return damagedRefusal(exemplar);
}

/** Availability of one copy in the send chooser: unavailable or damaged copies stay listed, disabled, with the reason. */
export function sendChoiceAvailability(exemplar) {
  if (!exemplar?.available) return { enabled: false, reasonKey: 'catalogue:reason.action.fileUnavailable' };
  const damage = damagedLine(exemplar);
  return damage ? { enabled: false, reasonKey: damage.key, reasonParams: damage.params } : { enabled: true, reasonKey: null };
}

/** D41: the user picks the copy whenever a card has several that can leave (never for an official card). */
export function needsSendChoice(card, devices = []) {
  return !isOfficialCard(card, devices) && sendableExemplars(card).length > 1;
}

/**
 * Asks, one card after the other and before anything starts, which copy to send.
 * `ask(card)` resolves to an exemplar id, or null when the user cancels that card:
 * the card then leaves the send (no refusal, no message). Cards that need no
 * choice are kept untouched.
 * @returns {{cards: Array, chosen: Map<string, string>}}
 */
export async function resolveSendChoices(cards, devices, ask) {
  const chosen = new Map(), kept = [];
  for (const card of cards) {
    if (!ask || !needsSendChoice(card, devices)) { kept.push(card); continue; }
    const exemplarId = await ask(card);
    if (exemplarId == null) continue;
    chosen.set(card.id, exemplarId);
    kept.push(card);
  }
  return { cards: kept, chosen };
}

/** Where a card already is on a device: screen position (null when hidden). */
export function presenceOn(device, card) {
  const row = luniiRows(device).find(r => !r.orphan && (r.catalogueFicheId === card.id || (card.uuids ?? []).some(uuid => sameUuid(uuid, r.key))));
  return row ? { key: row.key, position: row.position, hidden: Boolean(row.hidden) } : null;
}

/** A Lunii story already known to be official on any open device. */
export function isOfficialCard(card, devices = []) {
  if (card?.official === true) return true;
  return devices.some(d => (d.stories ?? []).some(s => s.kind === 'official' && (card.uuids ?? []).some(uuid => sameUuid(uuid, s.key))));
}

/** Error code refusing any send to this device, or null. */
export function sendRefusal(device) { return luniiWriteRefusal(device, 'send'); }

/**
 * The Send button of a card in one of its states.
 * kind: none | official | ready | present | blocked | choose
 */
export function sendButtonState(card, devices, activeId) {
  const open = openDevices(devices);
  if (!open.length) return { kind: 'none' };
  const targets = open.map(device => ({ device, presence: presenceOn(device, card), refusal: sendRefusal(device) }));
  if (isOfficialCard(card, devices)) return { kind: 'official', targets };
  // Every available copy has a damaged picture: refused from the start, with the engine's own reason.
  const damaged = damagedCardRefusal(card);
  if (damaged) return { kind: 'blocked', targets, damaged };
  if (!sendableExemplar(card)) return { kind: 'blocked', targets, reasonKey: 'catalogue:actions.reason.noExemplar' };
  if (open.length >= 2) return { kind: 'choose', targets };
  const [target] = targets;
  if (target.presence) return { kind: 'present', targets, target };
  if (target.refusal) return { kind: 'blocked', targets, target, refusal: target.refusal };
  return { kind: 'ready', targets, target: targets.find(t => t.device.id === activeId) ?? target };
}

/** Insertion boundary in the full device order (hidden included), from zero. */
export function dropIndex(device, rowKey) {
  const stories = device?.stories ?? [];
  if (rowKey == null) return stories.length;
  const index = stories.findIndex(s => s.key === rowKey);
  return index < 0 ? stories.length : index;
}
/** Number shown on screen (visible stories only, from one) for an insertion index. */
export function screenPosition(device, index) {
  return (device?.stories ?? []).slice(0, index).filter(s => !s.hidden).length + 1;
}
/** Screen position of the insertion, from the command position (null = end). */
export function sendPositions(device, index, count) {
  const first = screenPosition(device, index ?? device?.stories?.length ?? 0);
  return Array.from({ length: count }, (_, i) => first + i);
}

/** Engine-side estimate stays authoritative; this one sums the known copy sizes. */
export function estimateBytes(cards) {
  let bytes = 0, unknown = 0;
  for (const card of cards) {
    const size = sendableExemplar(card)?.sizeBytes;
    if (Number.isInteger(size)) bytes += size; else unknown += 1;
  }
  return { bytes, unknown };
}
export function dropGauge(device, estimate) {
  const total = device?.totalBytes ?? 0, free = device?.freeBytes;
  const used = free == null ? null : Math.max(0, total - free);
  return {
    added: estimate.bytes, unknown: estimate.unknown,
    remaining: free == null ? null : Math.max(0, free - estimate.bytes),
    usedFraction: total > 0 && used != null ? Math.min(1, used / total) : 0,
    addedFraction: total > 0 ? Math.min(1, estimate.bytes / total) : 0,
    overflow: free != null && estimate.bytes > free,
  };
}

/** Cards that may leave for a Lunii: official stories never do, nor those whose every copy has a damaged picture. */
export function sendableCards(cards, devices = []) { return cards.filter(card => !isOfficialCard(card, devices) && !damagedCardRefusal(card)); }

/**
 * Why none of these cards may be dropped on a Lunii, or null when at least one may:
 * `{kind: 'official'}` or `{kind: 'damaged', reason: {code, params}}` (the first damaged card).
 */
export function dropRefusal(cards, devices = []) {
  if (!cards.length || sendableCards(cards, devices).length) return null;
  const reason = cards.filter(card => !isOfficialCard(card, devices)).map(damagedCardRefusal).find(Boolean);
  return reason ? { kind: 'damaged', reason } : { kind: 'official' };
}

/**
 * Cards to send, in catalogue order, with the engine's explicit target
 * (the copy in `chosen` by card id, else the reference one).
 * `official` cards are left out before the engine and reported in the bilan, and so
 * are the `damaged` ones (every copy has a damaged picture found at import).
 */
export function buildSelection(cards, revision, devices = [], chosen = new Map()) {
  const entries = [], skipped = [], official = [], damaged = [];
  for (const card of cards) {
    if (isOfficialCard(card, devices)) { official.push(card); continue; }
    if (damagedCardRefusal(card)) { damaged.push(card); continue; }
    // A copy named by the user is sent as is; if it is no longer available the card is set aside.
    const exemplar = chosen.has(card.id) ? sendableExemplars(card).find(e => e.id === chosen.get(card.id)) ?? null : sendableExemplar(card);
    if (exemplar) entries.push({ selection: { exemplarId: exemplar.id, expectedRevision: revision }, card });
    else skipped.push(card);
  }
  return { entries, skipped, official, damaged };
}

/** What a send shows of each story, from the moment it is queued until its bilan. */
export function sendEntryItems(entries) {
  return entries.map(({ selection, card }) => ({ exemplarId: selection.exemplarId, ficheId: card.id, title: cardTitle(card), coverSignature: card.coverSignature ?? null }));
}

export function sendContext({ operationId, device, startIndex, cards, entries, skipped = [], official = [], damaged = [] }) {
  const refused = (card, code, params = {}) => ({ ficheId: card.id, title: cardTitle(card), reason: { code, params } });
  const refusedCard = card => {
    if (official.includes(card)) return refused(card, 'STORYTELLER_OFFICIAL_REFUSED');
    const reason = damaged.includes(card) ? damagedCardRefusal(card) : null;
    return reason ? refused(card, reason.code, reason.params) : refused(card, 'NO_EXEMPLAR');
  };
  return {
    operationId, deviceId: device.id, deviceName: device.name ?? null, startIndex,
    startPosition: screenPosition(device, startIndex),
    entries: sendEntryItems(entries),
    // Catalogue order, like the cards themselves.
    refused: [...official, ...damaged, ...skipped].sort((a, b) => cards.indexOf(a) - cards.indexOf(b)).map(refusedCard),
    cards: cards.length,
  };
}

export function sendTerminal(snapshot) { return ['success', 'partial', 'failed', 'cancelled'].includes(snapshot?.status); }

/** Per-story lines of an operation snapshot, joined with the context's titles. */
export function sendItems(context, snapshot) {
  const byId = new Map((snapshot?.result?.stories ?? []).map(item => [item.exemplarId, item]));
  return context.entries.map(entry => ({ ...entry, step: 'pending', progress: 0, reason: null, deviceFault: false, ...(byId.get(entry.exemplarId) ?? {}) }));
}
export function sendProgress(context, snapshot) {
  const items = sendItems(context, snapshot);
  const settled = items.filter(i => SETTLED.includes(i.step)).length;
  const current = items.find(i => ACTIVE_STEPS.includes(i.step)) ?? null;
  const total = items.length;
  const percent = total ? Math.min(100, Math.round((settled * 100 + (current?.progress ?? 0)) / total)) : 0;
  return { items, total, settled, current, percent, cancelling: snapshot?.status === 'cancelling' };
}
const STEP_KEYS = {
  pending: 'catalogue:lunii.sendStep.pending', preparing: 'catalogue:lunii.sendStep.preparing', generating: 'catalogue:lunii.sendStep.generating',
  convertingSounds: 'catalogue:lunii.sendStep.convertingSounds', convertingImages: 'catalogue:lunii.sendStep.convertingImages', encrypting: 'catalogue:lunii.sendStep.encrypting',
  copying: 'catalogue:lunii.sendStep.copying', finalizing: 'catalogue:lunii.sendStep.finalizing', done: 'catalogue:lunii.sendStep.done',
};
export function sendStepKey(step) { return STEP_KEYS[step] ?? STEP_KEYS.pending; }

/** Rows to show in the panel before the device list is read again. */
export function virtualRows(context, snapshot) {
  const items = sendItems(context, snapshot);
  const rows = [];
  let shown = 0;
  for (const item of items) {
    if (['refused', 'failed', 'interrupted', 'notStarted'].includes(item.step) || (item.step === 'pending' && sendTerminal(snapshot))) continue;
    rows.push({ key: `sending:${item.exemplarId}`, index: context.startIndex + shown, origin: context.startIndex, position: context.startPosition + shown, title: item.title, ficheId: item.ficheId, coverSignature: item.coverSignature, step: item.step, progress: item.progress });
    shown += 1;
  }
  return rows;
}
/** Real rows with the sending ones merged at their insertion index. */
export function mergeSendingRows(rows, virtual) {
  if (!virtual.length) return rows;
  const listed = rows.filter(r => !r.orphan), orphans = rows.filter(r => r.orphan);
  const out = [];
  let before = 0;
  for (let i = 0; i <= listed.length; i += 1) {
    // A queued story is not on the Lunii yet: it takes no number and shifts none.
    for (const v of virtual.filter(row => Math.min(row.origin ?? row.index, listed.length) === i)) { out.push({ ...v, sending: true }); if (!v.queued) before += 1; }
    if (i < listed.length) out.push(listed[i].position == null ? listed[i] : { ...listed[i], position: listed[i].position + before });
  }
  return [...out, ...orphans];
}

/** Count file failures only in the engine's structured validation list, never in raw text or labels. */
function missingFileCount(cause) {
  if (cause?.code === 'FILES_NOT_FOUND_OR_INACCESSIBLE') return 1;
  if (cause?.code !== 'VALIDATION_PROJECT_ERRORS' || !Array.isArray(cause.params?.errors?.messages)) return null;
  const count = cause.params.errors.messages.reduce((total, message) => total + (missingFileCount(message) ?? 0), 0);
  return count || null;
}

/** Why a story did not leave: i18n key, parameters and the follow-up action. */
export function refusalPresentation(reason, { position = null } = {}) {
  const code = reason?.code;
  switch (code) {
    case 'STORYTELLER_OFFICIAL_REFUSED': return { key: 'catalogue:lunii.officialReason', params: {}, action: null };
    case 'STORYTELLER_STORY_DUPLICATE': {
      const at = position ?? reason?.params?.position ?? null;
      return at == null ? { key: 'catalogue:lunii.sendRefused.duplicateUnlisted', params: {}, action: 'see' } : { key: 'catalogue:lunii.sendRefused.duplicate', params: { position: at }, action: 'see' };
    }
    case 'STORYTELLER_STORY_DUPLICATE_UNLISTED': return { key: 'catalogue:lunii.sendRefused.duplicateUnlisted', params: {}, action: 'see' };
    case 'STORYTELLER_NO_SPACE': return { key: 'catalogue:lunii.sendRefused.noSpace', params: {}, bytes: reason?.params?.missingBytes ?? null, action: null };
    case 'STORYTELLER_NO_SPACE_UNKNOWN': return { key: 'catalogue:lunii.sendRefused.noSpaceUnknown', params: {}, action: null };
    case 'STORYTELLER_PROJECT_INCOMPLETE': {
      const count = missingFileCount(reason?.params?.cause);
      return { key: count == null ? 'catalogue:lunii.sendRefused.incomplete' : 'catalogue:lunii.sendRefused.incompleteCount', params: count == null ? {} : { count }, action: 'editor' };
    }
    case 'STORYTELLER_NAVIGATION_REFUSED': return { key: 'catalogue:lunii.sendRefused.navigation', params: {}, action: 'editor' };
    case 'STORYTELLER_IMAGE_UNREADABLE':
    case 'STORYTELLER_SOUND_UNREADABLE': {
      // A screen name dropped as private data leaves the sentence without it.
      const named = typeof reason?.params?.screen === 'string' && reason.params.screen.trim() !== '';
      const unnamed = code === 'STORYTELLER_IMAGE_UNREADABLE' ? 'STORYTELLER_IMAGE_UNREADABLE_UNNAMED' : 'STORYTELLER_SOUND_UNREADABLE_UNNAMED';
      return { key: null, params: {}, reason: named ? reason : { code: unnamed, params: {} }, action: 'editor' };
    }
    case 'STORYTELLER_IMAGE_UNREADABLE_UNNAMED':
    case 'STORYTELLER_SOUND_UNREADABLE_UNNAMED': return { key: null, params: {}, reason, action: 'editor' };
    case 'NO_EXEMPLAR': return { key: 'catalogue:actions.reason.noExemplar', params: {}, action: null };
    default: return { key: null, params: {}, reason, action: null };
  }
}

/** Bilan of a finished (or running) send. Cancelled rows are not refusals. */
export function sendReport(context, snapshot, devices = []) {
  const items = sendItems(context, snapshot);
  const device = devices.find(d => d.id === context.deviceId);
  const done = [], refused = [], failed = [], notStarted = [];
  let interrupted = null, warning = false;
  items.forEach(item => {
    if (item.step === 'done') { done.push({ ...item, position: context.startPosition + done.length }); if (item.reason) warning = true; return; }
    if (item.step === 'interrupted') { if (interrupted) notStarted.push(item); else interrupted = item; return; }
    if (['pending', 'notStarted'].includes(item.step)) { notStarted.push(item); return; }
    if (!['refused', 'failed'].includes(item.step)) return;
    if (CANCEL_CODES.includes(item.reason?.code)) { notStarted.push(item); return; }
    const card = { id: item.ficheId, uuids: [] };
    const here = device ? presenceOn(device, card) : null;
    (item.step === 'refused' ? refused : failed).push({ ...item, presentation: refusalPresentation(item.reason, { position: here?.position ?? null }), seeKey: here?.key ?? null });
  });
  for (const local of context.refused ?? []) refused.push({ ...local, presentation: refusalPresentation(local.reason), seeKey: null });
  return { done, refused, failed, interrupted, notStarted, deviceFault: items.some(item => item.deviceFault === true), cancelled: notStarted.length, warning, status: snapshot?.status ?? 'running', deviceName: context.deviceName };
}
/** "4 et 5" style list is formatted by the view; here just the numbers. */
export function reportPositions(report) { return report.done.map(d => d.position); }

/** Only an explicitly queued, unplugged send delegates its story to the queue report. */
export function queueSendInterruption(context, snapshot) {
  if (!context?.queueEntryId || !sendTerminal(snapshot)) return null;
  const interrupted = sendReport(context, snapshot).interrupted;
  return interrupted?.reason?.code === 'STORYTELLER_SEND_DISCONNECTED' ? interrupted : null;
}

/** Only a finished multi-operation run can replace the send's own bilan.
 * Keep the terminal card until publication, and keep ownership after dismissal.
 */
export function queueCoversSend(context, queues = {}) {
  if (!context?.queueEntryId) return false;
  const entries = queues[context.deviceId] ?? [];
  const entry = entries.find(item => item.id === context.queueEntryId);
  if (!entry?.sendInterruption) return false;
  const run = entries.filter(item => item.run === entry.run);
  return run.length >= 2 && !run.some(item => ['queued', 'running'].includes(item.state));
}

export function sendCoverAddress(row) { return coverAddress(row.ficheId, row.coverSignature); }

/** Signature used by the pill: a new transfer, or a send where something did not leave, opens it. */
export function sendAttention(context, snapshot) {
  if (context?.local) return `attention:${context.operationId}`;
  if (!sendTerminal(snapshot)) return `start:${context.operationId}`;
  return ['interrupted', 'failed', 'partial'].includes(sendBilanKind(sendReport(context, snapshot)).kind) ? `attention:${context.operationId}` : null;
}

const NOW_KEYS = {
  pending: 'catalogue:lunii.sendNow.preparing', preparing: 'catalogue:lunii.sendNow.preparing', generating: 'catalogue:lunii.sendNow.generating',
  convertingSounds: 'catalogue:lunii.sendNow.preparing', convertingImages: 'catalogue:lunii.sendNow.preparing', encrypting: 'catalogue:lunii.sendNow.preparing',
  copying: 'catalogue:lunii.sendNow.copying', finalizing: 'catalogue:lunii.sendNow.finalizing',
};
export function sendNowKey(step) { return NOW_KEYS[step] ?? NOW_KEYS.preparing; }

/**
 * Title key and tone of the single bilan entry of a send: everything left,
 * part of it, or nothing. A cut or a cancellation keeps its own title.
 */
export function sendBilanKind(report) {
  if (report.interrupted) return { kind: 'interrupted', tone: 'issue', titleKey: 'catalogue:lunii.sendBilan.interrupted' };
  if (report.status === 'cancelled') return { kind: 'cancelled', tone: 'info', titleKey: 'catalogue:lunii.sendBilan.cancelled' };
  if (!report.done.length) return { kind: 'failed', tone: 'issue', titleKey: 'catalogue:lunii.sendBilan.failed' };
  if (report.refused.length || report.failed.length || report.cancelled || report.status === 'failed') return { kind: 'partial', tone: 'issue', titleKey: 'catalogue:lunii.sendBilan.partial' };
  return { kind: 'done', tone: 'success', titleKey: 'catalogue:lunii.sendBilan.done' };
}

/** Keys that open the activity pill for the sends: a start, then a failure or a cut; a send refused before it started too. */
export function sendOpenKeys(snapshots, contextFor, localContexts = []) {
  return [
    ...snapshots.filter(s => s.operationKind === 'luniiSend').map(s => {
      const context = contextFor(s.operationId);
      if (context) return sendAttention(context, s);
      // No context, no bilan to show: only the start and a whole failure count.
      if (!sendTerminal(s)) return `start:${s.operationId}`;
      return s.status === 'failed' ? `attention:${s.operationId}` : null;
    }),
    ...localContexts.filter(c => c.local).map(c => sendAttention(c, null)),
  ].filter(Boolean);
}
