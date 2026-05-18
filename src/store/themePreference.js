const STORAGE_KEY = 'storyStudioThemePreference';

export const THEME_OPTIONS = [
  { value: 'system', label: 'Système' },
  { value: 'dark', label: 'Sombre' },
  { value: 'light', label: 'Clair' },
];

export function loadThemePreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return THEME_OPTIONS.some((option) => option.value === value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function saveThemePreference(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
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
