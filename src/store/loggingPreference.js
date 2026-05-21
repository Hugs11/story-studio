const STORAGE_KEY = 'storyStudio.verboseLogging';

export function loadVerboseLoggingPref() {
  if (typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(STORAGE_KEY) === '1'; }
  catch { return false; }
}

export function saveVerboseLoggingPref(enabled) {
  if (typeof window === 'undefined') return;
  try {
    if (enabled) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

export function verboseLevelName(enabled) {
  return enabled ? 'info' : 'warn';
}
