import i18next, { createInstance } from 'i18next';
import frProduction from '../locales/fr/production.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };
import { presentStoredError, presentUserMessage } from './userMessage.js';

const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'production', keySeparator: false, initAsync: false,
  resources: { fr: { production: frProduction, common: frCommon } }, interpolation: { escapeValue: false } });
export function translateProduction(key, params) {
  const engine = i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'production') ? i18next : source;
  return engine.t(key, params);
}
export function productionRef(key, params) { return params ? { key, params } : { key }; }
export function presentProduction(value) {
  if (!value?.key?.startsWith('production:')) return value;
  return translateProduction(value.key, Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) =>
    [name, Array.isArray(param?.messages) ? param.messages.map(message => param.data && typeof message === 'string' ? message : presentStoredError(message)).join(param.separator ?? '')
      : param && typeof param === 'object' ? presentStoredError(param) : param])));
}
// Les refus gardent leur API texte, mais leurs champs sont résolus à chaque lecture.
// Le rapport ou dialogue peut ainsi rester ouvert pendant un changement de langue.
export function productionTextFields(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value?.key?.startsWith('production:')) Object.defineProperty(fields, name, {
      enumerable: true, configurable: true, get: () => presentProduction(value),
    });
  }
  return fields;
}

export function productionTechnicalDetail(value) {
  if (value?.key?.startsWith('production:')) return Object.values(value.params ?? {}).map(productionTechnicalDetail).filter(Boolean).join('\n');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'userMessage')) return presentUserMessage(value.userMessage).technicalDetail;
  return value instanceof Error || value?.code ? presentUserMessage(value).technicalDetail : '';
}

// Le message d'erreur d'un travail graphe refusé : une référence au refus, jamais
// une copie de son texte, pour que journal, rapport et copie suivent la langue.
export function productionRefusalMessage(refusal) {
  return refusal ? { productionRefusal: refusal } : null;
}
