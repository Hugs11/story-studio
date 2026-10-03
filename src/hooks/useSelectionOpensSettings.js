import { useSyncExternalStore } from 'react';

import {
  readSelectionOpensSettings,
  subscribeSelectionOpensSettings,
} from '../store/selectionOpensSettings.js';

// La préférence « sélectionner ouvre les réglages », suivie par les vues qui
// l'affichent dès qu'elle change ailleurs.
export function useSelectionOpensSettings() {
  return useSyncExternalStore(
    subscribeSelectionOpensSettings,
    readSelectionOpensSettings,
    readSelectionOpensSettings,
  );
}
