import i18next, { createInstance } from 'i18next';
import frGraph from '../locales/fr/graph.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };

// Les présentations pures et les essais peuvent précéder le Provider React.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'graph', keySeparator: false, initAsync: false,
  resources: { fr: { graph: frGraph, common: frCommon } }, interpolation: { escapeValue: false } });
export function graphTranslationEngine() {
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'graph') ? i18next : source;
}
export function translateGraph(key, params) {
  return graphTranslationEngine().t(key, params);
}

// Les repères portent des textes de présentation hérités ; seuls leurs libellés
// changent ici. La géométrie, les identifiants et les noms d’auteur sont conservés.
export function presentGraphLandmarks(marks, linkCountKey = 'graph:overlay.landmark.linkCount', translator = translateGraph) {
  return marks.map((mark) => {
    if (mark.kind === 'entry') return { ...mark,
      label: mark.label === null ? null : translator('graph:overlay.entree.label'),
      title: mark.node.label ?? translator('graph:overlay.entree.label'),
    };
    if (mark.kind === 'hub') {
      const params = { name: mark.node.label, count: mark.node.degree ?? 0 };
      const label = params.count === 0
        ? translator('graph:overlay.landmark.linkCountAtZero', params)
        : translator(linkCountKey, params);
      return { ...mark, label: mark.label === null ? null : label, title: mark.title === null ? null : label };
    }
    return mark;
  });
}

// Les erreurs locales et libellés conservés portent une référence ; aucune locale dans l’IPC.
export function presentGraph(value) {
  if (!value?.key?.startsWith('graph:')) return value;
  return translateGraph(value.key, Object.fromEntries(Object.entries(value.params ?? {}).map(([name, param]) => [name, presentGraph(param)])));
}
export function graphPresentationError(ErrorType, key, params = {}) {
  const error = new ErrorType();
  error.presentationRef = { key, params };
  Object.defineProperty(error, 'message', { configurable: true, get: () => presentGraph(error.presentationRef) });
  return error;
}
