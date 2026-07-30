import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings.js';

// Voix Piper par défaut — doit correspondre au catalogue Rust
// (`services/piper/catalog.rs`).
export const PIPER_DEFAULT_VOICE = 'fr_FR-siwis-medium';

const DEFAULT_XTTS_SETTINGS = {
  // Moteur TTS actif. Piper est le défaut zéro-config ; XTTS reste
  // opt-in pour les avancés (clonage de voix, qualité max).
  backend: 'piper',
  enabled: false,
  serverUrl: 'http://127.0.0.1:8020',
  xttsDir: '',
  autoStart: true,
  forceCpu: false,
  language: 'fr',
  favoriteVoices: [],
  // Réglages Piper.
  piperVoice: PIPER_DEFAULT_VOICE,
  piperSpeed: 1.0,
};

function withoutLegacyPiperSettings(settings) {
  const portable = { ...(settings ?? {}) };
  delete portable.piperSentenceSilence;
  return portable;
}

export function loadXttsSettings() {
  try {
    const raw = readSetting(KEYS.XTTS_SETTINGS);
    if (!raw) return { ...DEFAULT_XTTS_SETTINGS };
    const parsed = {
      ...DEFAULT_XTTS_SETTINGS,
      ...withoutLegacyPiperSettings(JSON.parse(raw)),
    };
    return {
      ...parsed,
      favoriteVoices: Array.isArray(parsed.favoriteVoices) ? parsed.favoriteVoices : [],
    };
  } catch {
    return { ...DEFAULT_XTTS_SETTINGS };
  }
}

export function saveXttsSettings(settings) {
  writeSetting(KEYS.XTTS_SETTINGS, JSON.stringify({
    ...DEFAULT_XTTS_SETTINGS,
    ...withoutLegacyPiperSettings(settings),
  }));
}

// Le bouton TTS est disponible quand Piper est actif (zéro-config, toujours
// dispo) ou quand XTTS a été explicitement activé. Centralise la condition
// d'affichage du bouton « Générer une voix ».
export function isTtsAvailable(settings) {
  if (!settings) return false;
  return settings.backend === 'piper' || settings.enabled === true;
}
