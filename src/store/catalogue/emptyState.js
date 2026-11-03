import i18next from 'i18next';
import { translateCatalogue as t } from '../../i18n/cataloguePresentation.js';
import { emptyCatalogueState, EMPTY_KEYS } from './operationView.js';
// Une phrase et, quand elle existe, une action utile : ajouter un dossier,
// ouvrir les préférences du catalogue ou effacer les filtres.
const ACTIONS = Object.freeze({
  noSources: { action: 'addFolder', key: 'catalogue:sources.add.label' },
  offline: { action: 'preferences', key: 'catalogue:preferences.link.label' },
  noPacks: { action: 'preferences', key: 'catalogue:preferences.link.label' },
  filtered: { action: 'reset', key: 'catalogue:empty.filtered.action' },
});
export function catalogueEmptyState(context) {
  const state = emptyCatalogueState(context);
  const action = ACTIONS[state];
  return { state, filters: state === 'filtered' ? context.summary ?? [] : [], key: EMPTY_KEYS[state], actionKey: action?.key ?? null, action: action?.action ?? null };
}

/** Phrase traduite de l'état vide, avec les mêmes critères et règles de liste. */
export function emptyStateSentence(empty, view, summaryLabel) {
  const labels = view?.summary.map(summaryLabel) ?? [];
  const query = view?.query.trim() ? view.query : '';
  const list = new Intl.ListFormat(i18next.resolvedLanguage ?? 'fr', { style: 'long', type: 'conjunction' }).format(labels.map(filter => t('catalogue:empty.filtered.quoted', { filter })));
  return empty.state !== 'filtered' || !view ? t(empty.key) : query && labels.length ? t('catalogue:empty.filtered.both', { count: labels.length, query, filters: list })
    : labels.length ? t('catalogue:empty.filtered.filters', { count: labels.length, filters: list }) : query ? t('catalogue:empty.filtered.queryOnly', { query }) : t(empty.key);
}
