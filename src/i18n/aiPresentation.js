import i18next, { createInstance } from 'i18next';
import frAi from '../locales/fr/ai.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };

// Le catalogue source sert aux consommateurs purs exécutés avant le Provider.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'ai', keySeparator: false, initAsync: false,
  resources: { fr: { ai: frAi, common: frCommon } }, interpolation: { escapeValue: false } });
export function translateAi(key, params) {
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', key.split(':')[0])
    ? i18next.t(key, params) : source.t(key, params);
}
export function aiRef(key, params) { return params ? { key, params } : { key }; }
export function presentAi(value) {
  if (value?.key?.startsWith('ai:')) return translateAi(value.key,
    Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [name, presentAi(param)])));
  return value;
}
