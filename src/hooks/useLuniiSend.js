import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { luniiDeviceApi } from '../store/catalogue/luniiDeviceApi.js';
import { buildSelection, resolveSendChoices, dropGauge, dropIndex, dropRefusal, estimateBytes, sendableCards, sendContext, sendPositions, sendRefusal, sendTerminal, virtualRows } from '../store/catalogue/luniiSend.js';

// Like operation trackers, send metadata belongs to the API session, not the screen.
// Completed contexts are kept only for their bilan, until it is dismissed.
const sessions = new WeakMap();
const notifySession = session => { for (const listener of session.listeners) listener(); };

/**
 * Sending catalogue cards to a Lunii: the drag, the contexts of the transfers
 * (titles and insertion point, which the engine does not echo) and the settling
 * of each device once its operation is over.
 */
export function useLuniiSend({ lunii, operations, cards, revision, chooseExemplar = null, api = luniiDeviceApi }) {
  const key = operations.sessionKey ?? api;
  if (!sessions.has(key)) sessions.set(key, { contexts: [], finished: new Set(), settling: new Map(), listeners: new Set() });
  const session = sessions.get(key);
  const [contexts, renderContexts] = useState(() => session.contexts);
  const [finished, renderFinished] = useState(() => session.finished);
  useEffect(() => {
    const sync = () => { renderContexts(session.contexts); renderFinished(session.finished); };
    session.listeners.add(sync);
    sync(); // Also catches a receipt delivered between render and subscription.
    return () => { session.listeners.delete(sync); };
  }, [session]);
  const setContexts = useCallback(update => {
    session.contexts = update(session.contexts);
    renderContexts(session.contexts);
    notifySession(session);
  }, [session]);
  const finish = useCallback(operationId => {
    session.finished = new Set(session.finished).add(operationId);
    renderFinished(session.finished);
    notifySession(session);
  }, [session]);
  const [drag, setDrag] = useState(null);
  const [over, setOver] = useState(null);
  const latest = useRef({});
  latest.current = { lunii, operations, cards, revision, contexts, chooseExemplar };
  const items = operations.state.items;

  /** Frees the reservation of ONE send, once: a late or repeated call never frees a later send's. */
  const release = useCallback(async (operationId, deviceId) => {
    if (session.finished.has(operationId)) return;
    if (!session.settling.has(operationId)) {
      const work = latest.current.lunii.store.endSend(deviceId).then(() => {
        finish(operationId);
        const context = latest.current.contexts.find(c => c.operationId === operationId);
        latest.current.operations.release?.(context?.requestId ?? operationId);
        session.settling.delete(operationId);
      });
      session.settling.set(operationId, work);
    }
    await session.settling.get(operationId);
  }, [session, finish]);

  useEffect(() => {
    for (const context of contexts) {
      if (session.finished.has(context.operationId) || !sendTerminal(items[context.operationId])) continue;
      void release(context.operationId, context.deviceId);
    }
  }, [contexts, items, release, session]);

  useEffect(() => {
    // A reservation may settle while its original screen is unmounted.
    for (const context of contexts) {
      const key = context.requestId ?? context.operationId;
      if (session.finished.has(context.operationId) && operations.state.retained?.[key]) operations.release?.(key);
    }
    const dismissed = contexts.filter(c => !c.local && session.finished.has(c.operationId)
      && (operations.state.dismissed?.[c.operationId] || !items[c.operationId]));
    if (!dismissed.length) return;
    const ids = new Set(dismissed.map(c => c.operationId));
    setContexts(list => list.filter(c => !ids.has(c.operationId)));
    session.finished = new Set([...session.finished].filter(id => !ids.has(id)));
    renderFinished(session.finished);
    notifySession(session);
  }, [contexts, finished, operations, operations.state.dismissed, operations.state.retained, items, session, setContexts]);

  const contextFor = useCallback(operationId => latest.current.contexts.find(c => c.operationId === operationId) ?? null, []);
  const sending = useMemo(() => new Set(contexts.filter(c => !finished.has(c.operationId)).map(c => c.deviceId)), [contexts, finished]);
  const virtualFor = useCallback(deviceId => contexts.filter(c => c.deviceId === deviceId && !finished.has(c.operationId))
    .flatMap(c => virtualRows(c, items[c.operationId])), [contexts, finished, items]);

  /**
   * Send the given catalogue cards; `index` null appends (or a function of the device, read
   * once the choices are made). D41: a card with several sendable copies asks which one first,
   * card by card; cancelling a box drops only that card, and nothing starts when none is left.
   * Refusals never reach the engine.
   */
  const sendCards = useCallback(async (deviceId, cardIds, indexOf = null) => {
    const { lunii: first, cards: all } = latest.current;
    if (!first.luniiDevices.some(d => d.id === deviceId)) return null;
    const asked = cardIds.map(id => all.find(card => card.id === id)).filter(Boolean);
    if (!asked.length) return null;
    const { cards: picked, chosen } = await resolveSendChoices(asked, first.luniiDevices, latest.current.chooseExemplar);
    if (!picked.length) return null;
    // The Lunii and the catalogue may have moved while the boxes were open.
    const { lunii: state, revision: expected } = latest.current;
    const device = state.luniiDevices.find(d => d.id === deviceId);
    if (!device) return null;
    const index = typeof indexOf === 'function' ? indexOf(device) : indexOf;
    const refusal = state.store.beginSend(deviceId);
    if (refusal) { state.store.reportError({ code: refusal, params: {} }); return null; }
    const { entries, skipped, official, damaged } = buildSelection(picked, expected, state.luniiDevices, chosen);
    const at = index == null ? device.stories.length : index;
    let started = false;
    let requestId;
    try {
      if (!entries.length) {
        const context = { ...sendContext({ operationId: `local:${crypto.randomUUID()}`, device, startIndex: at, cards: picked, entries, skipped, official, damaged }), local: true };
        setContexts(list => [...list, context]);
        await release(context.operationId, deviceId);
        return context;
      }
      requestId = crypto.randomUUID();
      latest.current.operations.retain?.(requestId);
      const receipt = await api.send({ deviceId, selection: entries.map(e => e.selection), position: index == null ? null : index, requestId });
      started = true;
      const context = { ...sendContext({ operationId: receipt.operationId, device, startIndex: at, cards: picked, entries, skipped, official, damaged }), requestId };
      setContexts(list => [...list, context]);
      await latest.current.operations.open(receipt.operationId);
      return context;
    } catch (error) {
      state.store.reportError(error);
      // Once the engine accepted the send, the settling effect owns the release.
      if (!started) {
        if (requestId) latest.current.operations.release?.(requestId);
        await state.store.endSend(deviceId);
      }
      return null;
    }
  }, [api, release, setContexts]);

  /** Clears the bilan entry of a send that never reached the engine. */
  const dismissLocal = useCallback(operationId => {
    if (!session.contexts.some(c => c.local && c.operationId === operationId)) return;
    setContexts(list => list.filter(c => c.operationId !== operationId));
    session.finished = new Set([...session.finished].filter(id => id !== operationId));
    renderFinished(session.finished);
    notifySession(session);
  }, [session, setContexts]);

  const startDrag = useCallback(cardIds => setDrag({ cardIds }), []);
  const endDrag = useCallback(() => { setDrag(null); setOver(null); }, []);
  /** Hovering a boundary of a device: insertion index and the gauge to show. */
  const hover = useCallback((device, rowKey, cardIds = drag?.cardIds) => {
    const current = latest.current;
    if (!cardIds?.length || !device || sendRefusal(device)) { setOver(null); return false; }
    const picked = sendableCards(cardIds.map(id => current.cards.find(card => card.id === id)).filter(Boolean), current.lunii?.luniiDevices);
    // Nothing may leave (official, or every copy damaged): the refusal is shown over the target, nothing is inserted.
    if (!picked.length) {
      const asked = cardIds.map(id => current.cards.find(card => card.id === id)).filter(Boolean);
      const refusal = dropRefusal(asked, current.lunii?.luniiDevices) ?? { kind: 'official' };
      const same = previous => previous?.deviceId === device.id && previous.refused === refusal.kind && JSON.stringify(previous.reason ?? null) === JSON.stringify(refusal.reason ?? null);
      setOver(previous => same(previous) ? previous : { deviceId: device.id, refused: refusal.kind, ...(refusal.reason ? { reason: refusal.reason } : {}) });
      return true;
    }
    const index = dropIndex(device, rowKey);
    const estimate = estimateBytes(picked);
    setOver(previous => previous?.deviceId === device.id && previous.index === index && previous.count === picked.length ? previous
      : { deviceId: device.id, index, rowKey: rowKey ?? null, count: picked.length, position: sendPositions(device, index, 1)[0], gauge: dropGauge(device, estimate) });
    return true;
  }, [drag]);
  const leave = useCallback(() => setOver(null), []);
  const drop = useCallback(async (device, rowKey, cardIds = drag?.cardIds) => {
    const ids = cardIds;
    setDrag(null); setOver(null);
    if (!ids?.length || !device) return null;
    const refusal = sendRefusal(device);
    if (refusal) { latest.current.lunii.store.reportError({ code: refusal, params: {} }); return null; }
    // Same as the greyed Send button: dropping only official stories does nothing.
    const { cards: all, lunii: state } = latest.current;
    if (!sendableCards(ids.map(id => all.find(card => card.id === id)).filter(Boolean), state.luniiDevices).length) return null;
    return sendCards(device.id, ids, current => dropIndex(current, rowKey));
  }, [drag, sendCards]);

  return { contexts, contextFor, sending, virtualFor, sendCards, dismissLocal, drag, over, startDrag, endDrag, hover, leave, drop, cancel: operations.cancel };
}
