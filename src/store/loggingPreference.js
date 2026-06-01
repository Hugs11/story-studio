import { KEYS, read as readSetting, write as writeSetting, remove as removeSetting } from './persistentSettings';

export function loadVerboseLoggingPref() {
  if (typeof window === 'undefined') return false;
  try { return readSetting(KEYS.VERBOSE_LOGGING) === '1'; }
  catch { return false; }
}

export function saveVerboseLoggingPref(enabled) {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) writeSetting(KEYS.VERBOSE_LOGGING, '1');
    else removeSetting(KEYS.VERBOSE_LOGGING);
  } catch { /* ignore */ }
}

export function verboseLevelName(enabled) {
  return enabled ? 'info' : 'warn';
}
