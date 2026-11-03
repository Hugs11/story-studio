import i18n from 'i18next';
import { KEYS, read, write, hasExistingSettings } from '../store/persistentSettings.js';

// Langues publiques dont la couverture traduite est relue et à jour.
export const PUBLIC_LANGUAGES = Object.freeze(['fr', 'en', 'it']);
export const DEV_LANGUAGES = Object.freeze(['fr', 'en', 'it', 'pseudo']);
export const AVAILABLE_LANGUAGES = import.meta.env?.DEV ? DEV_LANGUAGES : PUBLIC_LANGUAGES;

const INTL_LOCALES = { fr: 'fr-FR', en: 'en-US', it: 'it-IT' };

function systemBaseLanguage(systemLanguage) {
  return String(systemLanguage ?? '').toLowerCase().split(/[-_]/)[0];
}

function isPersistentLanguage(language, languages) {
  return language !== 'pseudo' && languages.includes(language);
}

// Résolution pure ; la liste injectée permet de tester une ouverture publique future.
export function resolveLanguage({
  preference, existingInstallation = false, systemLanguage, languages = AVAILABLE_LANGUAGES,
} = {}) {
  if (isPersistentLanguage(preference, languages)) return preference;
  if (existingInstallation) return 'fr';
  const base = systemBaseLanguage(systemLanguage);
  return isPersistentLanguage(base, languages) ? base : 'en';
}

// Resolve before settings migrations: their defaults must not make a new install look old.
export function loadLanguage(systemLanguage = globalThis.navigator?.language, {
  languages = AVAILABLE_LANGUAGES, settings = { read, write, hasExistingSettings }, persist = true,
} = {}) {
  const preference = settings.read(KEYS.UI_LANGUAGE);
  const validPreference = isPersistentLanguage(preference, languages);
  const existingInstallation = !validPreference && settings.hasExistingSettings();
  const language = resolveLanguage({ preference, existingInstallation, systemLanguage, languages });
  if (persist && !validPreference) {
    if (existingInstallation) {
      if (systemBaseLanguage(systemLanguage) !== 'fr' && settings.read(KEYS.UI_LANGUAGE_ANNOUNCEMENT) !== 'dismissed') {
        settings.write(KEYS.UI_LANGUAGE_ANNOUNCEMENT, 'pending');
      }
      settings.write(KEYS.UI_LANGUAGE, language);
    } else if (isPersistentLanguage(language, languages)) {
      settings.write(KEYS.UI_LANGUAGE, language);
    }
  }
  return language;
}

export function getIntlLocale() {
  return INTL_LOCALES[i18n.language === 'pseudo' ? 'fr' : i18n.language] ?? INTL_LOCALES.en;
}

export function updateDocumentLanguage(language) {
  if (typeof document !== 'undefined') {
    document.documentElement.lang = language === 'pseudo' ? 'fr' : language;
  }
}

export function changeUiLanguage(language) {
  const allowed = AVAILABLE_LANGUAGES.includes(language);
  const next = allowed ? language : 'en';
  // Le projet et son historique ne sont pas consommateurs de cette préférence.
  if (allowed && next !== 'pseudo') write(KEYS.UI_LANGUAGE, next);
  return i18n.changeLanguage(next);
}
