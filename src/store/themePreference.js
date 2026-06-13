import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings';

export const THEME_OPTIONS = [
  { value: 'system', label: 'Système' },
  { value: 'dark', label: 'Sombre' },
  { value: 'light', label: 'Clair' },
];

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function loadThemePreference() {
  try {
    const value = readSetting(KEYS.THEME);
    return THEME_OPTIONS.some((option) => option.value === value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePreference(value) {
  try {
    writeSetting(KEYS.THEME, value);
  } catch {}
}

function getSystemTheme() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

export function resolveThemePreference(value) {
  return value === 'dark' || value === 'light' ? value : getSystemTheme();
}

export function applyThemePreference(value) {
  if (typeof document === 'undefined') return;
  const preference = value === 'dark' || value === 'light' ? value : 'system';
  const root = document.documentElement;

  function applyResolvedTheme() {
    const resolved = resolveThemePreference(preference);
    if (preference === 'dark' || preference === 'light') {
      root.dataset.theme = preference;
    } else if (resolved === 'dark') {
      root.dataset.theme = 'dark';
    } else {
      delete root.dataset.theme;
    }
    root.style.colorScheme = resolved;
  }

  applyResolvedTheme();

  if (preference !== 'system' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return undefined;
  }

  const media = window.matchMedia(DARK_QUERY);
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', applyResolvedTheme);
  } else {
    media.addListener?.(applyResolvedTheme);
  }

  return () => {
    if (typeof media.removeEventListener === 'function') {
      media.removeEventListener('change', applyResolvedTheme);
    } else {
      media.removeListener?.(applyResolvedTheme);
    }
  };
}
