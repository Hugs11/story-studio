import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings.js';

// Voix Piper par défaut — doit correspondre au catalogue Rust
// (`services/piper/catalog.rs`).
export const PIPER_DEFAULT_VOICE = 'fr_FR-siwis-medium';
export const PIPER_DEFAULT_LANGUAGE = 'fr_FR';

export const PIPER_LANGUAGE_OPTIONS = [
  { value: 'fr_FR', label: 'Français', defaultVoice: PIPER_DEFAULT_VOICE },
  { value: 'en_GB', label: 'English UK', defaultVoice: 'en_GB-jenny_dioco-medium' },
  { value: 'en_US', label: 'English US', defaultVoice: 'en_US-kristin-medium' },
  { value: 'it_IT', label: 'Italiano', defaultVoice: 'it_IT-serena-medium' },
];

export function piperDefaultVoiceForLanguage(voices, language) {
  const catalogDefault = voices.find((voice) => voice.language === language && voice.isDefault);
  if (catalogDefault) return catalogDefault.id;
  const configuredDefault = PIPER_LANGUAGE_OPTIONS.find((option) => option.value === language)?.defaultVoice;
  return configuredDefault || PIPER_DEFAULT_VOICE;
}

export function piperLanguageForVoice(voices, voiceId, fallback = PIPER_DEFAULT_LANGUAGE) {
  return voices.find((voice) => voice.id === voiceId)?.language || fallback;
}

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
  piperLanguage: PIPER_DEFAULT_LANGUAGE,
  piperVoice: PIPER_DEFAULT_VOICE,
  piperSpeed: 1.0,
};

function withoutLegacyPiperSettings(settings) {
  const portable = { ...(settings ?? {}) };
  delete portable.piperSentenceSilence;
  if (portable.piperVoice === 'fr_FR-gilles-low') {
    portable.piperLanguage = PIPER_DEFAULT_LANGUAGE;
    portable.piperVoice = PIPER_DEFAULT_VOICE;
  }
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
    const piperLanguage = PIPER_LANGUAGE_OPTIONS.some(({ value }) => value === parsed.piperLanguage)
      ? parsed.piperLanguage
      : PIPER_DEFAULT_LANGUAGE;
    return {
      ...parsed,
      piperLanguage,
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
