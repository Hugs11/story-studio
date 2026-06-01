import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings';

const DEFAULT_SD_SETTINGS = {
  serverUrl: 'http://127.0.0.1:8188',
  autoStart: false,
  batPath: '',
  aiImageGen: false,
};

export function loadSdSettings() {
  try {
    const raw = readSetting(KEYS.SD_SETTINGS);
    if (!raw) return { ...DEFAULT_SD_SETTINGS };
    return { ...DEFAULT_SD_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SD_SETTINGS };
  }
}

export function saveSdSettings(settings) {
  writeSetting(KEYS.SD_SETTINGS, JSON.stringify(settings));
}
