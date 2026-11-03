import { KEYS, read } from '../store/persistentSettings.js';
import { getIntlLocale } from '../i18n/language.js';

export const PACK_AUDIO_EDGE_SILENCE_SECONDS = 0.4;
export const PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS = 0;
// Plafond commun aux Préférences et à la Fiche du pack. Au-delà, un silence ne
// sépare plus deux audios : il ressemble à une lecture bloquée sur la Lunii.
export const PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS = 10;

/**
 * Lit une durée saisie par l'auteur. `null` signifie « reprendre la
 * préférence », `undefined` signale une saisie incomplète ou invalide.
 * La virgule décimale française est acceptée, comme le point. Un champ vidé
 * vaut `null` : l'auteur efface sa personnalisation, il ne saisit pas zéro.
 * `max` n'est relâché que pour relire un projet déjà enregistré.
 */
export function parsePackAudioEdgeSilenceOverride(
  value,
  { max = PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS } = {},
) {
  if (value == null) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const source = typeof value === 'string' ? value.trim() : value;
  if (source === '') return null;
  if (typeof source === 'string' && !/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(source)) {
    return undefined;
  }
  const seconds = typeof source === 'string' ? Number(source.replace(',', '.')) : source;
  if (!Number.isFinite(seconds) || seconds < PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS) return undefined;
  if (seconds > max) return undefined;
  return Object.is(seconds, -0) ? 0 : seconds;
}

/** Les préférences sont bornées, jamais refusées : la saisie reste un nombre. */
export function normalizePackAudioEdgeSilence(
  value,
  fallback = PACK_AUDIO_EDGE_SILENCE_SECONDS,
) {
  if (value == null || value === '') return fallback;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return fallback;
  return Math.min(
    PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS,
    Math.max(PACK_AUDIO_EDGE_SILENCE_MIN_SECONDS, seconds),
  );
}

export function getPackAudioEdgeSilenceSettings() {
  return {
    leading: normalizePackAudioEdgeSilence(read(KEYS.PACK_LEADING_SILENCE_SECONDS)),
    trailing: normalizePackAudioEdgeSilence(read(KEYS.PACK_TRAILING_SILENCE_SECONDS)),
  };
}

/**
 * Retourne les personnalisations persistées d'un projet. Une valeur invalide
 * est traitée comme une absence afin qu'un ancien fichier ou une modification
 * manuelle ne puisse pas envoyer une durée erronée à l'export. Une durée
 * lisible mais enregistrée avant le plafond est bornée, comme une préférence :
 * l'intention de l'auteur — un long silence — est gardée au plus près.
 */
function readStoredOverride(value) {
  const seconds = parsePackAudioEdgeSilenceOverride(value, { max: Infinity });
  if (seconds === undefined || seconds === null) return null;
  return Math.min(PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS, seconds);
}

export function readPackAudioEdgeSilenceOverrides(globalOptions) {
  return {
    leadingSilenceSec: readStoredOverride(globalOptions?.leadingSilenceSec),
    trailingSilenceSec: readStoredOverride(globalOptions?.trailingSilenceSec),
  };
}

/** Résout les durées effectives du projet avec les préférences de l'application. */
export function resolvePackAudioEdgeSilence(
  globalOptions,
  defaults = getPackAudioEdgeSilenceSettings(),
) {
  const overrides = readPackAudioEdgeSilenceOverrides(globalOptions);
  return {
    leading: overrides.leadingSilenceSec ?? normalizePackAudioEdgeSilence(defaults?.leading),
    trailing: overrides.trailingSilenceSec ?? normalizePackAudioEdgeSilence(defaults?.trailing),
  };
}

export function formatPackAudioEdgeSilence(seconds = PACK_AUDIO_EDGE_SILENCE_SECONDS) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '1 s';
  return Number.isInteger(value) ? `${value} s` : `${value.toLocaleString(getIntlLocale())} s`;
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
 * Lu par la « Fiche du pack » **et** par la demande qui part au
 * moteur : deux lectures divergentes feraient afficher un réglage et en envoyer
 * un autre.
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
