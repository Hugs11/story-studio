import { useEffect, useState, useSyncExternalStore } from 'react';
import { luniiDeviceApi } from '../store/catalogue/luniiDeviceApi.js';
import { createLuniiDevices } from '../store/catalogue/luniiDevices.js';
import { luniiActivity } from '../store/luniiCloseGuard.js';

// The queue and its inventory watcher belong to the API session. Leaving the
// catalogue must neither lose the runner nor unregister pending work.
const sessions = new WeakMap();
export function useLuniiDevices(api = luniiDeviceApi) {
  const [session] = useState(() => {
    if (!sessions.has(api)) sessions.set(api, { store: createLuniiDevices(api), started: false });
    return sessions.get(api);
  });
  const { store } = session;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (session.started) return;
    session.started = true;
    store.start();
    luniiActivity.register(store);
  }, [session, store]);
  return { store, ...state };
}
