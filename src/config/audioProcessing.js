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
