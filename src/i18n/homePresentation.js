import i18next, { createInstance } from 'i18next';
import frHome from '../locales/fr/home.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };

// Les fonctions pures peuvent précéder le Provider ; le catalogue FR reste
// leur unique source. Résoudre à l'appel, jamais au chargement d'une table.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'home', keySeparator: false, initAsync: false,
  resources: { fr: { home: frHome, common: frCommon } }, interpolation: { escapeValue: false } });
export function translateHome(key, params) {
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'home')
    ? i18next.t(key, params) : source.t(key, params);
}
