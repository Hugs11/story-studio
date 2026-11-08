// Signaler à l'ajout les sons dont le niveau pose problème ? Préférence de
// l'application, activée par défaut. Désactivée, aucune mesure n'est lancée
// à l'ajout ni à l'affichage d'un son déjà présent, et aucun repère n'apparaît ;
// concerné.

import { KEYS, read, write } from './persistentSettings.js';

export const DEFAULT_AUDIO_LEVEL_ALERTS = true;

const listeners = new Set();
let cached = null;

export function readAudioLevelAlerts() {
  if (cached !== null) return cached;
  const raw = read(KEYS.AUDIO_LEVEL_ALERTS);
  cached = raw === null ? DEFAULT_AUDIO_LEVEL_ALERTS : raw === 'true';
  return cached;
}

export function writeAudioLevelAlerts(enabled) {
  cached = enabled === true;
  write(KEYS.AUDIO_LEVEL_ALERTS, String(cached));
  for (const listener of listeners) listener();
}

export function subscribeAudioLevelAlerts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Pour les essais : oublier la valeur lue, sans toucher au stockage.
export function resetAudioLevelAlertsCache() {
  cached = null;
}
