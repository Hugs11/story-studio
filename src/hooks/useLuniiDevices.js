import { useEffect, useState, useSyncExternalStore } from 'react';
import { luniiDeviceApi } from '../store/catalogue/luniiDeviceApi.js';
import { createLuniiDevices } from '../store/catalogue/luniiDevices.js';

export function useLuniiDevices(api = luniiDeviceApi) {
  const [store] = useState(() => createLuniiDevices(api));
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => store.start(), [store]);
  return { store, ...state };
}
