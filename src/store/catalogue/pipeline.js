// Pipeline unique de consultation : recherche → filtres → tri. Les trois vues
// affichent exactement son résultat ; il ne dépend pas de l'ordre d'entrée.

import { exemplarPredicate, evaluateCard, normalizeFilters } from './filters.js';
import { matchCard, searchWords } from './search.js';
import { compareExemplars } from './entryModel.js';
import { sortEntries, titleCollator } from './sort.js';

/**
 * Exemplaire représentatif parmi ceux qui satisfont les filtres : le plus
 * récemment modifié, départagé par l'ordre des exemplaires de la fiche.
 */
export function representativeExemplar(exemplars) {
  let best = null;
  for (const exemplar of exemplars) {
    if (best === null) { best = exemplar; continue; }
    const newer = (exemplar.modifiedAt ?? -Infinity) - (best.modifiedAt ?? -Infinity);
    if (newer > 0 || (newer === 0 && compareExemplars(exemplar, best) < 0)) best = exemplar;
  }
  return best;
}

/**
 * @param {Array} cards fiches normalisées
 * @param {{query?: string, filters?: object, sort?: object, language?: string}} options
 * @returns {{ids: string[], counts: {fiches: number, exemplaires: number},
 *   explanations: Map<string, Array>, representatives: Map<string, object>,
 *   matchingExemplars: Map<string, string[]>}}
 */
export function runPipeline(cards, { query = '', filters = {}, sort, language = 'fr' } = {}) {
  const words = searchWords(query);
  const normalized = normalizeFilters(filters);
  const predicate = exemplarPredicate(normalized);
  const entries = [];
  const explanations = new Map();
  for (const card of cards) {
    const explanation = matchCard(card, words);
    if (explanation === null) continue;
    const evaluation = evaluateCard(card, normalized, predicate);
    if (!evaluation) continue;
    entries.push({ card, matching: evaluation.exemplars, representative: representativeExemplar(evaluation.exemplars) });
    if (explanation.length) explanations.set(card.id, explanation);
  }
  const sorted = sortEntries(entries, sort, { collator: titleCollator(language) });
  return {
    ids: sorted.map((entry) => entry.card.id),
    counts: {
      fiches: sorted.length,
      exemplaires: sorted.reduce((total, entry) => total + entry.matching.length, 0),
    },
    explanations,
    representatives: new Map(sorted.map((entry) => [entry.card.id, entry.representative])),
    matchingExemplars: new Map(sorted.map((entry) => [entry.card.id, entry.matching.map((exemplar) => exemplar.id)])),
  };
}

/**
 * Fiches présentées, dans l'ordre du pipeline, avec leurs exemplaires
 * correspondant aux filtres : la seule entrée des trois vues.
 * @returns {Array<{card: object, exemplars: Array, representative: object|null}>}
 */
export function presentResults(cards, result) {
  const byId = new Map(cards.map((card) => [card.id, card]));
  return result.ids.flatMap((id) => {
    const card = byId.get(id);
    if (!card) return [];
    const matching = new Set(result.matchingExemplars.get(id) ?? []);
    return [{
      card,
      explanations: result.explanations.get(id) ?? [],
      exemplars: card.exemplars.filter((exemplar) => matching.has(exemplar.id)),
      representative: result.representatives.get(id) ?? null,
    }];
  });
}

/**
 * Pipeline mémoïsé : recalculé seulement si les fiches (même référence) ou
 * l'un des critères changent ; sinon le résultat précédent est rendu tel quel.
 */
const EMPTY_FILTERS = Object.freeze({});

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const explanationKeys = new WeakMap();
function explanationKey(list) {
  let key = explanationKeys.get(list);
  if (key === undefined) { key = JSON.stringify(list); explanationKeys.set(list, key); }
  return key;
}
// An unchanged card keeps its item object, so memoized cards skip rendering.
function reuseItems(previous, items) {
  if (!previous?.length) return items;
  const known = new Map(previous.map(item => [item.card.id, item]));
  return items.map(item => {
    const old = known.get(item.card.id);
    return old && old.card === item.card && old.representative === item.representative && sameList(old.exemplars, item.exemplars)
      && (old.explanations === item.explanations || explanationKey(old.explanations) === explanationKey(item.explanations)) ? old : item;
  });
}

export function memoizePipeline(run = runPipeline) {
  let last = null;
  return (cards, { query = '', filters = EMPTY_FILTERS, sort, language = 'fr' } = {}) => {
    if (last && last.cards === cards && last.query === query && last.filters === filters
      && last.sort?.key === sort?.key && last.sort?.direction === sort?.direction && last.language === language) {
      return last.value;
    }
    const result = run(cards, { query, filters, sort, language });
    last = { cards, query, filters, sort, language, value: { result, items: reuseItems(last?.value.items, presentResults(cards, result)) } };
    return last.value;
  };
}
