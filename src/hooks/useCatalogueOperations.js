import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { catalogueApi } from '../store/catalogue/catalogueApi.js';
import { createProgressBuffer, INITIAL_OPERATIONS, operationReducer, rememberFileTitles, namedFileSnapshot } from '../store/catalogue/operationView.js';

// Screen unmounts do not forget explicit dismissals or closed trackers.
const sessions = new WeakMap();
export function useCatalogueOperations({ api = catalogueApi(), cards = [] } = {}) {
  if (!sessions.has(api)) sessions.set(api, { state: INITIAL_OPERATIONS, listeners: new Set(), fileTitles: new Map() });
  const session = sessions.get(api);
  const [state, setState] = useState(() => session.state);
  const [ready, setReady] = useState(false);
  const subscription = useRef(null);
  const deliveryRef = useRef(null);
  // Reduce synchronously against the session, never a render awaiting its passive
  // effect. Late receipts and releases remain authoritative even during unmount.
  const dispatch = useCallback(action => {
    session.state = operationReducer(session.state, action);
    if (!session.listeners.size) session.state = { ...session.state, selected: null };
    for (const listener of session.listeners) listener(session.state);
  }, [session]);
  useLayoutEffect(() => {
    session.listeners.add(setState);
    setState(session.state);
    return () => {
      session.listeners.delete(setState);
      if (!session.listeners.size) session.state = { ...session.state, selected: null };
    };
  }, [session, dispatch]);
  useEffect(() => { rememberFileTitles(session.fileTitles, cards); }, [session, cards]);
  useEffect(() => {
    setReady(false);
    let stopped = false;
    let unlisten;
    const deliver = async (snapshot, retainedOperationIds, explicit) => {
      let named = snapshot;
      try { named = await namedFileSnapshot(snapshot, api, session.fileTitles); }
      catch { /* The operation still has its authoritative counters if report loading fails. */ }
      if (!stopped) dispatch({ type: 'snapshot', snapshot: named, retainedOperationIds, explicit });
    };
    // Serialize registry reads and their deliveries: an older response must not
    // re-admit an expired ID after a newer response discarded its tombstone.
    let delivery = Promise.resolve();
    const enqueue = (snapshots, explicit = false) => {
      delivery = delivery.then(async () => {
        if (stopped) return;
        let retainedOperationIds;
        try { ({ retainedOperationIds } = await api.listOperations()); }
        catch (error) { if (!stopped) dispatch({ type: 'error', error }); }
        // Registry failure must not discard authoritative progress or terminals.
        for (const snapshot of snapshots) {
          if (stopped) return;
          await deliver(snapshot, retainedOperationIds, explicit);
        }
      }).catch(error => { if (!stopped) dispatch({ type: 'error', error }); });
      return delivery;
    };
    deliveryRef.current = enqueue;
    const buffer = createProgressBuffer({ deliver: (items) => {
      if (!stopped) void enqueue(items);
    } });
    const setup = async () => {
      try {
        unlisten = await api.subscribeOperations((snapshot) => buffer.push(snapshot));
        if (stopped) { unlisten(); return; }
        // Subscription precedes both recovery and launching a new scan.
        let items = [];
        let recovered = false;
        try { ({ items } = await api.listOperations()); recovered = true; }
        catch (error) { if (!stopped) dispatch({ type: 'error', error }); }
        if (!stopped) {
          if (recovered) await enqueue(items);
          if (!stopped) setReady(recovered);
        }
      } catch (error) { if (!stopped) dispatch({ type: 'error', error }); throw error; }
    };
    subscription.current = setup();
    void subscription.current.catch(() => {});
    return () => { stopped = true; buffer.dispose(); unlisten?.(); };
  }, [api, dispatch, session]);
  const start = useCallback(async (expectedSourcesRevision, { sourceIds, paths, automatic = false } = {}) => {
    await subscription.current;
    const receipt = await api.startScan({ sourceIds, paths, requestId: crypto.randomUUID(), expectedSourcesRevision });
    const snapshot = await api.getOperation(receipt.operationId);
    await deliveryRef.current([snapshot], !automatic);
    if (!automatic) dispatch({ type: 'open', id: receipt.operationId });
    return receipt;
  }, [api, dispatch]);
  const cancel = useCallback(async (id) => {
    try { await deliveryRef.current([await api.cancelOperation(id)]); }
    catch (error) { dispatch({ type: 'error', error }); }
  }, [api, dispatch]);
  const open = useCallback(async (id) => {
    try {
      const snapshot = await api.getOperation(id);
      await deliveryRef.current([snapshot], true);
      dispatch({ type: 'open', id });
    } catch (error) { dispatch({ type: 'error', error }); }
  }, [api, dispatch]);
  const close = useCallback((id) => dispatch({ type: 'closeTracker', id }), [dispatch]);
  const dismiss = useCallback((id) => dispatch({ type: 'dismiss', id }), [dispatch]);
  const retain = useCallback((id) => dispatch({ type: 'retain', id }), [dispatch]);
  const release = useCallback((id) => dispatch({ type: 'release', id }), [dispatch]);
  return { state, ready, start, cancel, open, close, dismiss, retain, release, sessionKey: api };
}
