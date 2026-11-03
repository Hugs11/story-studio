import i18next, { createInstance } from 'i18next';
import frHelp from '../locales/fr/help.json' with { type: 'json' };
import { translateCommon } from './commonPresentation.js';
import { useMessageLanguage } from './useMessageLanguage.js';

// Les bancs purs précèdent l’initialisation : repli au catalogue, pas aux littéraux.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'help', keySeparator: false, initAsync: false,
  resources: { fr: { help: frHelp } }, interpolation: { escapeValue: false } });
export function translateHelp(key, params) {
  if (key.startsWith('common:')) return translateCommon(key, params);
  return i18next.isInitialized ? i18next.t(key, params) : source.t(key, params);
}

export function useHelpTranslation() {
  useMessageLanguage();
  return { t: translateHelp, language: i18next.resolvedLanguage ?? 'fr' };
}
