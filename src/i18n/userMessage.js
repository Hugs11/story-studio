import { presentProduction, productionTechnicalDetail } from './productionPresentation.js';
import { presentImportWarning } from './importWarnings.js';
import { translateImport } from './importPresentation.js';
import { presentGraph } from './graphPresentation.js';
import { presentTree } from "./treePresentation.js";
import { translateHome } from './homePresentation.js';
import { presentAi } from './aiPresentation.js';
import { presentMedia } from './mediaPresentation.js';
import { isExamplesRef, presentExamples } from './examplesPresentation.js';
import { checkerTechnicalDetail, isCheckerRef, presentChecker } from './checkerPresentation.js';
import frRust from '../locales/fr/rust.json' with { type: 'json' };
import frSettings from '../locales/fr/settings.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };
import i18next from 'i18next';
import registry from '../locales/_generated/rust-messages.json' with { type: 'json' };

// Les consommateurs purs et les bancs natifs peuvent précéder l’initialisation React.
function defaultTranslate(key, params = {}) {
  const translated = i18next.t(key, params);
  if (translated !== undefined) return translated;
  const [namespace, name] = key.split(':');
  const catalogue = namespace === 'rust' ? frRust : namespace === 'settings' ? frSettings : frCommon;
  const category = new Intl.PluralRules('fr').select(params.count);
  const source = catalogue[`${name}_${category}`] ?? catalogue[name];
  return source?.replace(/{{(.*?)}}/g, (_, param) => String(params[param] ?? ''));
}

const contracts = new Map(registry.map(({ code, params }) => [code, params]));
const pluralParameters = new Map(registry.filter(({ plural }) => plural).map(({ code, plural }) => [code, plural]));

// Independent counters keep their own agreement even when the main count differs.
const pluralParts = {
  "CHECKER_STRUCTURE_COUNTS": {
    "actions": "LABEL_COUNT_ACTIONS",
    "audio": "LABEL_COUNT_AUDIO",
    "images": "LABEL_COUNT_IMAGES"
  },
  "CHECKER_CORRECTIONS_SELECTION_SUMMARY": {
    "audioItems": "LABEL_COUNT_AUDIO_ITEMS",
    "optionalAudioSilencesFixed": "LABEL_COUNT_OPTIONAL_SUGGESTIONS",
    "imageItems": "LABEL_COUNT_IMAGEITEMS"
  },
  "CHECKER_REPORT_READY_SUMMARY": {
    "warningCount": "LABEL_COUNT_WARNINGCOUNT",
    "correctionCount": "LABEL_COUNT_CORRECTIONCOUNT"
  },
  "XTTS_VOICES_DETECTION_SUMMARY": {
    "speakers": "LABEL_COUNT_SPEAKERS",
    "referenceVoices": "LABEL_COUNT_REFERENCEVOICES"
  },
  "GENERATION_MEDIA_PREPARED_SUMMARY": {
    "prepared_assets_archive_entries": "LABEL_COUNT_ARCHIVE_FILES"
  },
  "INVALID_OPTION_PERMUTATION": {
    "rankCount": "LABEL_COUNT_RANKCOUNT"
  },
  "EXPORT_INTEROPERABILITY_DIMENSIONS_COUNT": {
    "readiness_unevaluated": "LABEL_COUNT_UNCHECKED_DIMENSIONS"
  }
};

// Closed application enums are labels; file formats, OS/codec data remain technical.
const parameterLabels = {
  "AUDIO_NOT_MONO": {
    "mode": {
      "stereo": "LABEL_AUDIO_MODE_STEREO",
      "joint stereo": "LABEL_AUDIO_MODE_JOINT",
      "dual channel": "LABEL_AUDIO_MODE_DUAL",
      "?": "LABEL_AUDIO_MODE_UNKNOWN"
    }
  },
  "CHECKER_VERDICT_CALCULATED_LOG": {
    "verdict": {
      "Valid": "LABEL_CHECKER_VERDICT_VALID",
      "ValidWithWarnings": "LABEL_CHECKER_VERDICT_WARNINGS",
      "NeedsFix": "LABEL_CHECKER_VERDICT_FIX",
      "Invalid": "LABEL_CHECKER_VERDICT_INVALID"
    }
  },
  "CHECKER_AUDIO_SUGGESTION_STALE": {
    "requestedEdge": {
      "Leading": "LABEL_SILENCE_START",
      "Trailing": "LABEL_SILENCE_END"
    }
  },
  "IMPORT_ARCHIVE_FILE_SIZE_LIMIT": {
    "kind": {
      "Asset": "LABEL_IMPORT_ASSET_KIND",
      "Thumbnail": "LABEL_IMPORT_THUMBNAIL_KIND"
    }
  },
  "EXPORT_INTEROPERABILITY_DIMENSIONS_COUNT": {
    "readiness_interoperability": {
      "Supported": "LABEL_EXPORT_INTEROP_SUPPORTED",
      "Prepared": "LABEL_EXPORT_INTEROP_PREPARED",
      "Untested": "LABEL_EXPORT_INTEROP_UNTESTED",
      "Invalid": "LABEL_EXPORT_INTEROP_REFUSED"
    }
  },
  "LABEL_SOURCE_ORIGIN_VALUE": {
    "payload_context_pack_identity_origin": {
      "SquareOneStage": "LABEL_IDENTITY_SOURCE_ENTRY",
      "FsEntryStage": "LABEL_IDENTITY_SOURCE_FILESYSTEM",
      "RequiresGeneration": "LABEL_IDENTITY_GENERATION_REQUIRED",
      "Generated": "LABEL_IDENTITY_ALREADY_GENERATED"
    }
  }
};

// Codes locaux du dépôt média : la raison peut être recopiée dans Error.message par
// le consommateur existant. Résoudre par code à l’affichage, sans classifier le texte.
const graphMediaRefusalKeys = { 'unsupported-kind': 'graph:drop.reason.kind', 'no-stage': 'graph:drop.reason.stage', 'no-path': 'graph:drop.reason.path' };

export function isRustMessageCode(code) { return contracts.has(code); }

export function rustMessageEnvelope(error) {
  if (typeof error?.event === 'string' && Object.hasOwn(error, 'payload')) return rustMessageEnvelope(error.payload);
  if (typeof error === 'string') {
    try {
      const parsed = JSON.parse(error);
      if (parsed && typeof parsed.code === 'string') return parsed;
    } catch { /* Le texte libre reste un détail technique. */ }
  }
  return error && typeof error === 'object' ? error : null;
}

// Job stores historically hold strings. Preserve a coded IPC envelope in that
// string contract until rendering; native JS Error objects supply technical text.
export function userMessageTransport(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  const envelope = rustMessageEnvelope(value);
  return envelope?.code ? JSON.stringify(envelope) : value == null ? '' : JSON.stringify(value);
}

/** Résout à la présentation ; les appelants replient technicalDetail dans <details>. */
// Avertissement de développement injectable (tests) ; console par défaut.
// eslint-disable-next-line no-console
export function presentUserMessage(error, { t = defaultTranslate, language = i18next.resolvedLanguage ?? 'fr', development = import.meta.env?.DEV ?? false, warn = console.warn, allowLegacyFrench = true } = {}) {
  if (error?.key?.startsWith('production:')) return { message: presentProduction(error), technicalDetail: productionTechnicalDetail(error), code: null, fallback: false };
  if (error?.key?.startsWith('ai:')) return { message: presentAi(error), technicalDetail: '', code: null, fallback: false };
  // Exemples du graphe : descripteur local, cause imbriquée présentée à la lecture.
  if (isExamplesRef(error)) return { message: presentExamples(error, (param) => presentStoredError(param, { t, language, development, warn, allowLegacyFrench })), technicalDetail: '', code: null, fallback: false };
  // Vérificateur et rapports : phrase du domaine, cause IPC imbriquée présentée à la lecture.
  if (isCheckerRef(error)) return { message: presentChecker(error), technicalDetail: checkerTechnicalDetail(error), code: null, fallback: false };
  // Refus de production gardé par référence : son message est relu dans la langue courante.
  if (error?.productionRefusal) return { message: String(error.productionRefusal.message ?? ''), technicalDetail: error.productionRefusal.technicalDetail ?? '', code: error.productionRefusal.code ?? null, fallback: false };
  const value = typeof error?.event === 'string' && Object.hasOwn(error, 'payload') ? error.payload : error;
  if (value === '' || value == null) return { message: '', technicalDetail: '', code: null, fallback: false };
  if (value instanceof Error && Object.hasOwn(graphMediaRefusalKeys, value.code)) return { message: t('common:error.fallback.unexpected'), technicalDetail: presentGraph({ key: graphMediaRefusalKeys[value.code] }), code: value.code, fallback: true };
  if (value?.presentationRef && (value.presentationRef.key?.startsWith('production:') || value.presentationRef.key?.startsWith('import:') || value.presentationRef.key?.startsWith('media:') || value.presentationRef.key?.startsWith('tree:') || value.presentationRef.key?.startsWith('examples:') || Array.isArray(value.presentationRef.parts) || Object.hasOwn(value.presentationRef, 'userMessage'))) return { message: presentStoredError(value.presentationRef, { t, language, development, warn, allowLegacyFrench }), technicalDetail: value.detail ?? '', code: value.code ?? null, fallback: storedErrorHasFallback(value.presentationRef, { t, language, development, warn, allowLegacyFrench }) };
  if (value?.key?.startsWith('import:')) return { message: presentStoredError(value, { t, language, development, warn, allowLegacyFrench }), technicalDetail: value.detail ?? '', code: value.code ?? null, fallback: storedErrorHasFallback(value, { t, language, development, warn, allowLegacyFrench }) };
  if (typeof value?.key === 'string' && value.key.startsWith('home:')) return { message: translateHome(value.key, value.params), technicalDetail: '', code: null, fallback: false };
  if (value?.presentationRef?.key?.startsWith('graph:')) return { message: presentGraph(value.presentationRef), technicalDetail: value.detail ?? '', code: null, fallback: false };
  if (value?.key?.startsWith('graph:')) return { message: presentGraph(value), technicalDetail: '', code: null, fallback: false };
  const envelope = rustMessageEnvelope(value);
  const nested = rustMessageEnvelope(envelope?.message);
  if (nested?.code) return presentUserMessage(nested, { t, language, development, warn, allowLegacyFrench });
  const code = envelope?.code ?? envelope?.kind;
  const contextCode = envelope?.params?.context;
  const presentationCode = code === 'STORYTELLER_STORY_DUPLICATE' && envelope?.params?.position == null
    ? 'STORYTELLER_STORY_DUPLICATE_UNLISTED' : typeof contextCode === 'string' && contextCode.startsWith(`${code}_`) && contracts.has(contextCode) ? contextCode : code;
  const names = contracts.get(presentationCode);
  const params = { ...(envelope?.params ?? {}) };
  // Historical ImportDiagnostic carries these typed fields even when params is empty.
  if (presentationCode === 'duplicate-root-key-last-wins' && Array.isArray(envelope?.discarded)) {
    const compact = (value) => {
      const characters = [...JSON.stringify(value)];
      return characters.length > 160 ? `${characters.slice(0, 160).join('')}…` : characters.join('');
    };
    params.discardedCount ??= envelope.discarded.length;
    params.discarded ??= envelope.discarded.map(compact).join(', ');
    params.retained ??= compact(envelope.retained ?? null);
  }
  if (envelope?.found !== undefined && envelope?.expected !== undefined) {
    Object.assign(params, { path: envelope.path, found: envelope.found, expected: envelope.expected });
  }
  const translatable = Boolean(names?.every((name) => Object.hasOwn(params, name)));
  const technicalDetail = technicalDetailOf(envelope, value, translatable, { t, language, development, warn, allowLegacyFrench });
  if (allowLegacyFrench && names && language === 'fr' && typeof envelope?.message === 'string' && !envelope?.params && !Array.isArray(envelope?.discarded)) {
    return { message: envelope.message, technicalDetail, code, fallback: false };
  }
  // Sans code dédié, conserver le texte français jusqu’à conversion du producteur.
  if (allowLegacyFrench && language === 'fr' && (!code || code === 'UNEXPECTED_ERROR') && technicalDetail) {
    return { message: technicalDetail, technicalDetail, code: code ?? null, fallback: false };
  }
  if (names && names.every((name) => Object.hasOwn(params, name))) {
    for (const [name, labels] of Object.entries(parameterLabels[presentationCode] ?? {})) {
      if (Object.hasOwn(labels, params[name])) params[name] = { code: labels[params[name]], params: {} };
    }
    const renderedParams = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, presentMessageParam(value, { t, language, development, warn, allowLegacyFrench })]));
    for (const [name, partCode] of Object.entries(pluralParts[presentationCode] ?? {})) {
      renderedParams[name] = presentUserMessage({ code: partCode, params: { count: params[name] } }, { t, language, development, warn, allowLegacyFrench }).message;
    }
    const plural = pluralParameters.get(presentationCode);
    if (plural) renderedParams.count = Number(params[plural]);
    return { message: t(`rust:${presentationCode}`, Object.hasOwn(renderedParams, 'ordinal') ? { ...renderedParams, ordinal: false, replace: renderedParams } : renderedParams), technicalDetail, code, fallback: Object.values(params).some(param => storedErrorHasFallback(param, { t, language, development, warn, allowLegacyFrench })) };
  }
  // Les paramètres des erreurs historiques seront remplis par leurs producteurs.
  // Aucune analyse de leur texte ne participe à la présentation.
  if (development) warn('Rust message fallback', { code, error });
  return { message: t('common:error.fallback.unexpected'), technicalDetail, code: code ?? null, fallback: true };
}

// A coded envelope is never shown as raw JSON: its code is the message.
// The detail is the producer's `detail`/`message` text (a nested coded
// envelope is presented), else the untranslated legacy texts carried by its
// parameters, else nothing when translated or the code and its parameter
// names when it is not.
// Raw JSON is reserved for uncoded values that carry nothing else.
function technicalDetailOf(envelope, value, translatable, options) {
  const raw = envelope?.detail ?? envelope?.message;
  if (raw != null && raw !== '') {
    const nested = rustMessageEnvelope(raw);
    if (nested?.code) return presentUserMessage(nested, options).message;
    return typeof raw === 'string' ? raw : JSON.stringify(raw) ?? '';
  }
  if (envelope?.code) return legacyTexts(envelope.params).join('\n') || (translatable ? '' : untranslatedCode(envelope));
  if (typeof value === 'string') return value;
  return value == null ? '' : JSON.stringify(value) ?? '';
}

// Code and parameter names, never their values (paths, user text).
function untranslatedCode(envelope) {
  const names = Object.keys(envelope.params ?? {});
  return names.length ? `${envelope.code} (${names.join(', ')})` : envelope.code;
}

// Uncoded strings of composite `messages` lists: legacy producer text that
// the translated message may omit outside French.
function legacyTexts(params, depth = 0) {
  if (!params || typeof params !== 'object' || depth > 4) return [];
  return Object.values(params).flatMap((param) => {
    if (Array.isArray(param?.messages)) return param.messages.flatMap((message) => typeof message === 'string' && !rustMessageEnvelope(message)?.code ? [message] : legacyTexts(rustMessageEnvelope(message)?.params, depth + 1));
    const nested = rustMessageEnvelope(param);
    return nested?.code ? legacyTexts(nested.params, depth + 1) : [];
  });
}

// Composite messages retain each cause's code and parameters through String services.
function presentMessageParam(value, options) {
  if (value?.key?.startsWith('common:')) return presentStoredError(value, options);
  if (value?.key?.startsWith('production:')) return presentProduction(value);
  if (value && typeof value === 'object' && Object.hasOwn(value, 'userMessage')) return presentStoredError(value, options);
  if (value?.key?.startsWith('import:')) return presentStoredError(value, options);
  if (value?.key?.startsWith('graph:')) return presentGraph(value);
  if (value?.key?.startsWith("tree:")) return presentTree(value);
  if (Array.isArray(value?.messages) && typeof value.separator === 'string') {
    return value.messages.map((message) => value.data && typeof message === 'string' && !rustMessageEnvelope(message)?.code ? message : presentUserMessage(message, options).message).join(value.separator);
  }
  const envelope = rustMessageEnvelope(value);
  if (envelope?.code) {
    const text = presentUserMessage(envelope, options).message;
    return value.case === 'lower' ? text.toLowerCase() : text;
  }
  return value;
}

// Technical evidence (hashes, filenames and external outputs) is stable data.
// Only application-authored envelopes are translated in these fields.
export function presentTechnicalMessage(value, options) {
  if (value?.key?.startsWith('settings:')) return presentStoredError(value, options);
  if (value?.key?.startsWith('ai:')) return presentAi(value);
  if (value?.key?.startsWith('import:') || value?.presentationRef) return presentStoredError(value, options);
  if (rustMessageEnvelope(value)?.code) return presentUserMessage(value, options).message;
  return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
}

// Error state keeps the original IPC value. Existing JS context remains a
// separate presentation fragment, rather than freezing the Rust translation.
export function presentStoredError(value, options) {
  if (value?.key?.startsWith('settings:')) return (options?.t ?? defaultTranslate)(value.key,
    Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [name, typeof param === 'object' && param !== null ? presentStoredError(param, options) : param])));
  if (value?.key?.startsWith('production:')) return presentProduction(value);
  if (value?.key?.startsWith('common:')) return (options?.t ?? defaultTranslate)(value.key, value.params);
  if (value?.key?.startsWith('ai:')) return presentAi(value);
  if (isCheckerRef(value)) return presentChecker(value);
  if (isExamplesRef(value)) return presentExamples(value, (param) => presentStoredError(param, options));
  if (value?.importWarning) return presentImportWarning(value.importWarning, options);
  if (value?.presentationRef) return presentStoredError(value.presentationRef, options);
  if (value?.key?.startsWith('import:')) return translateImport(value.key, Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [name, param && typeof param === 'object' ? presentStoredError(param, options) : param])));
  if (value?.key?.startsWith('graph:')) return presentGraph(value);
  if (typeof value?.key === 'string' && value.key.startsWith('tree:')) return presentTree(value);
  if (typeof value?.key === 'string' && value.key.startsWith('home:')) return translateHome(value.key, Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [name, typeof param === 'object' && param !== null ? presentStoredError(param, options) : param])));
  // Descripteurs du domaine Médias retenus dans l’état (préfixes, erreurs locales).
  if (typeof value?.key === 'string' && value.key.startsWith('media:')) return presentMedia(value);
  if (Array.isArray(value?.parts)) return value.parts.map((part) => presentStoredError(part, options)).join(value.separator ?? '');
  if (value && typeof value === 'object' && Object.hasOwn(value, 'userMessage')) {
    return `${presentStoredError(value.prefix ?? '', options)}${presentUserMessage(value.userMessage, value.codedOnly ? { ...options, allowLegacyFrench: false } : options).message}${presentStoredError(value.suffix ?? '', options)}`;
  }
  if (value instanceof Error) return presentUserMessage(value, options).message;
  return presentTechnicalMessage(value, options);
}

// Le repli d’une cause doit rester observable sur le message composite.
function storedErrorHasFallback(value, options) {
  if (!value || typeof value !== 'object') return false;
  if (value.presentationRef) return storedErrorHasFallback(value.presentationRef, options);
  if (Object.hasOwn(value, 'userMessage')) return presentUserMessage(value.userMessage, value.codedOnly ? { ...options, allowLegacyFrench: false } : options).fallback
    || storedErrorHasFallback(value.prefix, options) || storedErrorHasFallback(value.suffix, options);
  if (value.key || Array.isArray(value.parts)) return Object.values(value.params ?? value.parts ?? {}).some(part => storedErrorHasFallback(part, options));
  if (Array.isArray(value.messages)) return value.messages.some(message => storedErrorHasFallback(message, options));
  if (value.code) return presentUserMessage(value, options).fallback;
  return false;
}
