import { KEYS, read } from '../store/persistentSettings.js';

export const PACK_AUDIO_EDGE_SILENCE_SECONDS = 0.4;
export const PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS = 0;

export function normalizePackAudioEdgeSilence(
  value,
  fallback = PACK_AUDIO_EDGE_SILENCE_SECONDS,
) {
  if (value == null || value === '') return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallback;
  return Math.max(PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS, seconds);
}

export function getPackAudioEdgeSilenceSettings() {
  return {
    leading: normalizePackAudioEdgeSilence(read(KEYS.PACK_LEADING_SILENCE_SECONDS)),
    trailing: normalizePackAudioEdgeSilence(read(KEYS.PACK_TRAILING_SILENCE_SECONDS)),
  };
}

export function formatPackAudioEdgeSilence(seconds = PACK_AUDIO_EDGE_SILENCE_SECONDS) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '1 s';
  return Number.isInteger(value) ? `${value} s` : `${value.toLocaleString('fr-FR')} s`;
}

// ── Les réglages audio du pack, et leur source unique ───────────────────────
//
// Les deux éditeurs produisent un pack pour le même appareil : ils proposent
// donc les mêmes réglages, avec les mêmes valeurs pré-cochées, lues ici.
//
// Ces défauts sont **ceux du schéma Libre** (`normalizeOptions`), recopiés ici
// pour que l'éditeur graphe, qui ne traverse pas ce schéma, les lise au même
// endroit. Un projet graphe n'a pas de `globalOptions` tant que l'auteur n'a
// touché à rien : l'absence vaut donc le défaut, elle ne vaut pas « off ».
export const DEFAULT_PACK_AUDIO_PROCESSING = Object.freeze({
  silenceMode: 'normalize',
  harmonizeLoudness: true,
});

export const PACK_SILENCE_MODES = Object.freeze(['off', 'add', 'normalize']);

/**
 * Le traitement audio demandé par ce projet, quel que soit son éditeur.
 *
 * Lu par le tiroir d'options **et** par la demande qui part au moteur : deux
 * lectures divergentes feraient afficher un réglage et en envoyer un autre.
 */
export function readPackAudioProcessing(globalOptions) {
  const silenceMode = PACK_SILENCE_MODES.includes(globalOptions?.silenceMode)
    ? globalOptions.silenceMode
    : DEFAULT_PACK_AUDIO_PROCESSING.silenceMode;
  return {
    silenceMode,
    // `!== false` et non `?? true` : un projet Libre porte explicitement la
    // valeur, un projet graphe ne porte rien, et les deux doivent rendre le
    // même défaut.
    harmonizeLoudness: globalOptions?.harmonizeLoudness !== false,
  };
}
