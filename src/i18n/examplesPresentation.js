import i18next, { createInstance } from 'i18next';
import frExamples from '../locales/fr/examples.json' with { type: 'json' };
import enExamples from '../locales/en/examples.json' with { type: 'json' };
import itExamples from '../locales/it/examples.json' with { type: 'json' };
import { pseudoResources } from './pseudo.js';

// Langues dans lesquelles un exemple peut être créé. Le contenu (noms, récits,
// titres) est une donnée d'auteur une fois inséré : il est résolu **une fois**,
// dans la langue capturée au choix de l'exemple, par ce moteur dédié qui ne
// dépend ni de l'initialisation React ni de la langue courante de l'interface.
export const EXAMPLE_LANGUAGES = Object.freeze(['fr', 'en', 'it']);

const content = createInstance();
content.init({
  lng: 'fr', fallbackLng: 'fr', defaultNS: 'examples', ns: ['examples'], keySeparator: false,
  initAsync: false, returnNull: false, interpolation: { escapeValue: false },
  resources: { fr: { examples: frExamples }, en: { examples: enExamples }, it: { examples: itExamples } },
});

// La pseudo-locale de développement couvre aussi le contenu des exemples.
const PSEUDO = 'pseudo';

export function exampleContentLanguage(language) {
  const base = String(language ?? '').split('-')[0].toLowerCase();
  return base === PSEUDO || EXAMPLE_LANGUAGES.includes(base) ? base : 'fr';
}

// Langue parlée par les audios de l'exemple : la pseudo-locale reste française.
export function exampleSpeechLanguage(language) {
  const resolved = exampleContentLanguage(language);
  return resolved === PSEUDO ? 'fr' : resolved;
}

export function exampleTranslator(language) {
  const resolved = exampleContentLanguage(language);
  if (resolved === PSEUDO && !content.hasResourceBundle(PSEUDO, 'examples')) {
    content.addResourceBundle(PSEUDO, 'examples', pseudoResources(frExamples));
  }
  return content.getFixedT(resolved, 'examples');
}

// Présentation de l'interface : langue active, repli FR avant l'initialisation.
export function translateExamples(key, params) {
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'examples')
    ? i18next.t(key, params) : content.t(key, params);
}

// Descripteur `{ key, params }` gardé en état ; un paramètre objet (cause IPC,
// autre descripteur) est présenté par l'appelant, dans la langue courante.
export function presentExamples(value, presentParam = (param) => param) {
  const params = Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [
    name, param !== null && typeof param === 'object' ? presentParam(param) : param,
  ]));
  return translateExamples(value.key, params);
}

export function isExamplesRef(value) {
  return typeof value?.key === 'string' && value.key.startsWith('examples:');
}
