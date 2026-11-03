import { presentStoredError, presentUserMessage } from './userMessage.js';
import i18next, { createInstance } from 'i18next';
import frImport from '../locales/fr/import.json' with { type: 'json' };
import frNative from '../locales/fr/native.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };

// Les appels purs peuvent précéder le Provider. Les tables gardent des clés.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'import', keySeparator: false, initAsync: false,
  resources: { fr: { import: frImport, native: frNative, common: frCommon } },
  interpolation: { escapeValue: false } });
export function translateImport(key, params) {
  const namespace = key.split(':')[0];
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', namespace)
    ? i18next.t(key, params) : source.t(key, params);
}

// Le suivi fournit un état partagé ; seule sa présentation dans les imports est locale.
export function importFollowStatusText(follow) {
  if (follow.state === 'pending' && follow.enabled) return translateImport('import:media.follow.pending');
  if (follow.state === 'active') return follow.enabled
    ? translateImport('import:media.follow.active') : translateImport('import:media.follow.pauseOnSave');
  if (follow.state === 'paused') return follow.enabled
    ? translateImport('import:media.follow.resumeOnSave') : translateImport('import:media.follow.paused');
  return translateImport('import:media.follow.initial');
}

export function sourceImportValue(value) {
  if (value?.userMessage) return presentUserMessage(value.userMessage).message;
  if (value?.key?.startsWith('import:')) return source.t(value.key, value.params);
  return value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
}

export function importPresentationError(keyOrRef, params = {}, { code = null, detail = '', cause = null } = {}) {
  const ref = typeof keyOrRef === 'string' ? { key: keyOrRef, params } : keyOrRef;
  const error = new Error();
  error.presentationRef = ref;
  if (code) error.code = code;
  error.params = ref.params ?? {};
  error.detail = detail;
  if (cause != null) error.cause = cause;
  Object.defineProperty(error, 'message', { configurable: true, get: () => presentStoredError(ref) });
  return error;
}
