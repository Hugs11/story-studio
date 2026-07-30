import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings.js';

const DEFAULT_SD_SETTINGS = {
  serverUrl: 'http://127.0.0.1:8188',
  autoStart: false,
  launcherPath: '',
  aiImageGen: false,
};

export function loadSdSettings() {
  try {
    const raw = readSetting(KEYS.SD_SETTINGS);
    if (!raw) return { ...DEFAULT_SD_SETTINGS };
    const parsed = JSON.parse(raw);
    const { batPath, ...portable } = parsed;
    return {
      ...DEFAULT_SD_SETTINGS,
      ...portable,
      launcherPath: Object.hasOwn(portable, 'launcherPath')
        ? portable.launcherPath
        : (batPath ?? ''),
    };
  } catch {
    return { ...DEFAULT_SD_SETTINGS };
  }
}

export function saveSdSettings(settings) {
  const portable = { ...(settings ?? {}) };
  delete portable.batPath;
  writeSetting(KEYS.SD_SETTINGS, JSON.stringify({
    ...DEFAULT_SD_SETTINGS,
    ...portable,
  }));
}
