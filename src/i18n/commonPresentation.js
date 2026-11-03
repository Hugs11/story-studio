import i18next, { createInstance } from 'i18next';
import frCommon from '../locales/fr/common.json' with { type: 'json' };
import { useMessageLanguage } from './useMessageLanguage.js';

// Les fonctions pures et les bancs peuvent précéder le Provider ; le repli
// reste le catalogue FR, jamais une deuxième copie des textes dans le code.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'common', keySeparator: false, initAsync: false,
  resources: { fr: { common: frCommon } }, interpolation: { escapeValue: false } });
export function translateCommon(key, params) {
  return i18next.isInitialized ? i18next.t(key, params) : source.t(key, params);
}

export function useCommonTranslation() {
  useMessageLanguage();
  return { t: translateCommon, language: i18next.resolvedLanguage ?? 'fr' };
}

// Descripteurs gardés dans les dialogues : la langue se résout à l’affichage.
export function presentCommon(value) {
  return typeof value === 'string' && value.startsWith('common:') ? translateCommon(value) : value;
}
