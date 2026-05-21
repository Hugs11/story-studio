const XTTS_SETTINGS_KEY = 'xttsSettings';

const DEFAULT_XTTS_SETTINGS = {
  enabled: false,
  serverUrl: 'http://127.0.0.1:8020',
  xttsDir: '',
  autoStart: true,
  forceCpu: false,
  language: 'fr',
  favoriteVoices: [],
};

export function loadXttsSettings() {
  try {
    const raw = localStorage.getItem(XTTS_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_XTTS_SETTINGS };
    const parsed = { ...DEFAULT_XTTS_SETTINGS, ...JSON.parse(raw) };
    return {
      ...parsed,
      favoriteVoices: Array.isArray(parsed.favoriteVoices) ? parsed.favoriteVoices : [],
    };
  } catch {
    return { ...DEFAULT_XTTS_SETTINGS };
  }
}

export function saveXttsSettings(settings) {
  localStorage.setItem(XTTS_SETTINGS_KEY, JSON.stringify(settings));
}
