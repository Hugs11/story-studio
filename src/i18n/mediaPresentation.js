import i18next, { createInstance } from 'i18next';
import frMedia from '../locales/fr/media.json' with { type: 'json' };
import frNative from '../locales/fr/native.json' with { type: 'json' };
import frImport from '../locales/fr/import.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };

// Les fonctions pures et les bancs peuvent précéder le Provider ; le repli reste
// le catalogue FR, jamais une deuxième copie des textes dans le code.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'media', keySeparator: false, initAsync: false,
  resources: { fr: { media: frMedia, native: frNative, import: frImport, common: frCommon } },
  interpolation: { escapeValue: false } });

export function translateMedia(key, params) {
  const namespace = key.split(':')[0];
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', namespace)
    ? i18next.t(key, params) : source.t(key, params);
}

// Descripteurs { key, params } gardés dans l’état : résolus à l’affichage,
// paramètres imbriqués compris. Une chaîne reste une donnée (nom, chemin, détail).
export function presentMedia(value) {
  if (Array.isArray(value)) return value.map(presentMedia).join('');
  if (value && typeof value === 'object' && typeof value.key === 'string'
    && /^(?:media|native|common|import):/.test(value.key)) {
    const params = Object.fromEntries(Object.entries(value.params ?? {})
      .map(([name, param]) => [name, name === 'count' ? param : presentMedia(param)]));
    return translateMedia(value.key, params);
  }
  return value;
}

export function mediaRef(key, params) {
  return params ? { key, params } : { key };
}

// Refus d’un outil média : le code reste le contrat, `reasonRef` le descripteur
// à retenir, et `reason` (accesseur) le texte dans la langue active à la lecture.
export function mediaRefusal(fields, key, params) {
  const reasonRef = mediaRef(key, params);
  return Object.defineProperty({ ...fields, reasonRef }, 'reason', {
    enumerable: true, configurable: true, get: () => presentMedia(reasonRef),
  });
}
