import i18next, { createInstance } from 'i18next';
import frChecker from '../locales/fr/checker.json' with { type: 'json' };
import frNative from '../locales/fr/native.json' with { type: 'json' };
import frHome from '../locales/fr/home.json' with { type: 'json' };
import frProduction from '../locales/fr/production.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };
import { presentStoredError, presentUserMessage } from './userMessage.js';

// Vérificateur et rapports : les fonctions pures (exports, résumés, refus) et
// les bancs peuvent précéder le Provider. Le repli reste le catalogue FR, jamais
// une seconde copie des textes dans le code. Résoudre à l'affichage ou à l'export.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'checker', keySeparator: false, initAsync: false,
  resources: { fr: { checker: frChecker, native: frNative, home: frHome, production: frProduction, common: frCommon } },
  interpolation: { escapeValue: false } });

export function checkerEngine() {
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'checker') ? i18next : source;
}

export function translateChecker(key, params) {
  return checkerEngine().t(key, params);
}

// Descripteur retenu dans l'état (journal, notice, erreur) : résolu à la lecture.
export function checkerRef(key, params) {
  return params ? { key, params } : { key };
}

export function isCheckerRef(value) {
  return typeof value?.key === 'string' && value.key.startsWith('checker:');
}

export function presentChecker(value) {
  if (!isCheckerRef(value)) return value;
  const params = Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [
    name, name === 'count' || !param || typeof param !== 'object' ? param : presentStoredError(param),
  ]));
  return translateChecker(value.key, params);
}

// Le détail brut d'une cause IPC imbriquée reste disponible, replié par l'appelant.
export function checkerTechnicalDetail(value) {
  if (!isCheckerRef(value)) return '';
  return Object.values(value.params ?? {}).map((param) => {
    if (isCheckerRef(param)) return checkerTechnicalDetail(param);
    if (param && typeof param === 'object' && Object.hasOwn(param, 'userMessage')) return presentUserMessage(param.userMessage).technicalDetail;
    return '';
  }).filter(Boolean).join('\n');
}

// Séparateur décimal de la langue active ; le format FR d'origine reste « 0,30 ».
export function checkerDecimalSeparator() {
  const language = checkerEngine() === i18next ? i18next.resolvedLanguage : 'fr';
  const locale = { en: 'en-US', it: 'it-IT' }[language] ?? 'fr-FR';
  return new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? ',';
}
