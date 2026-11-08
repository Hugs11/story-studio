import { useSyncExternalStore } from 'react';

import { readAudioLevelAlerts, subscribeAudioLevelAlerts } from '../store/audioLevelAlertSettings.js';

// La préférence « signaler les sons à l'ajout », suivie par les Préférences.
export function useAudioLevelAlerts() {
  return useSyncExternalStore(subscribeAudioLevelAlerts, readAudioLevelAlerts, readAudioLevelAlerts);
}
