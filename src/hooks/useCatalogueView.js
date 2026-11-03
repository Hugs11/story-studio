import { usePersistentColumns } from './usePersistentColumns.js';
import { CATALOGUE_COLUMNS } from '../store/catalogue/listColumns.js';
import { filterScanAdditions } from '../store/catalogue/scanAdditions.js';
import { useMemo, useRef } from 'react';
import { memoizePipeline } from '../store/catalogue/pipeline.js';
import { filterSummary, effectiveCriteria } from '../store/catalogue/filterState.js';
import { useCatalogueFilters } from './useCatalogueFilters.js';
import { useCatalogueViewPrefs } from './useCatalogueViewPrefs.js';

export function useCatalogueView(cards, { language = 'fr' } = {}) {
  const { state, dispatch } = useCatalogueFilters();
  const prefs = useCatalogueViewPrefs();
  const listColumns = usePersistentColumns(CATALOGUE_COLUMNS);
  const memo = useRef(null);
  memo.current ??= memoizePipeline();
  const { result, items } = useMemo(() => {
    const subset = filterScanAdditions(cards, state.additions);
    return memo.current(subset, { ...effectiveCriteria(state), sort: prefs.sort, language });
  }, [cards, state, prefs.sort, language]);
  const summary = filterSummary(state);
  return { ...prefs, listColumns, filterState: state, query: state.query, filters: state.filters, summary, dispatch,
    setQuery: value => dispatch({ type: 'query', value }), result, items,
    total: cards.length,
    filtered: state.query.trim() !== '' || summary.length > 0 };
}
