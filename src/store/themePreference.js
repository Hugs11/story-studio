import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings';

export const THEME_OPTIONS = [
  { value: 'system', label: 'Système' },
  { value: 'dark', label: 'Sombre' },
  { value: 'light', label: 'Clair' },
];

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

export function applyThemePreference(value) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (value === 'dark' || value === 'light') {
    root.dataset.theme = value;
    root.style.colorScheme = value;
  } else {
    delete root.dataset.theme;
    root.style.colorScheme = '';
  }
}
