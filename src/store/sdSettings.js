export const SD_SETTINGS_KEY = 'sdSettings';

export const DEFAULT_SD_SETTINGS = {
  serverUrl: 'http://127.0.0.1:8188',
  autoStart: false,
  batPath: '',
  aiImageGen: false,
};

export function loadSdSettings() {
  try {
    const raw = localStorage.getItem(SD_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SD_SETTINGS };
    return { ...DEFAULT_SD_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SD_SETTINGS };
  }
}

export function saveSdSettings(settings) {
  localStorage.setItem(SD_SETTINGS_KEY, JSON.stringify(settings));
}
