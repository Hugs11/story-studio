import './CatalogueEmpty.css';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { catalogueEmptyState, emptyStateSentence } from '../../store/catalogue/emptyState.js';
import { useFilterLabels } from './CatalogueFilterBar.jsx';
import { Library, SearchX } from '../icons/LucideLocal.jsx';
import { Button } from '../common/Button.jsx';
export function CatalogueEmptyState({ onAddFolder, onPreferences, onRefresh, onClearFilters, view, cards = [], sources = [], tags = [], ...context }) {
  const { t } = useCatalogueTranslation();
  const { summaryLabel } = useFilterLabels(cards, sources, tags);
  const empty = catalogueEmptyState({ ...context, sources, summary: view?.summary });
  if (empty.state === 'ready') return null;
  const action = { addFolder: onAddFolder, preferences: onPreferences, refresh: onRefresh, reset: onClearFilters }[empty.action];
  const filtered = empty.state === 'filtered';
  const noSources = empty.state === 'noSources';
  const criteria = emptyStateSentence(empty, view, summaryLabel);
  return <section className="catalogue-empty" data-empty-state={empty.state}>
    {(filtered || noSources) && <span className="catalogue-empty-icon">{filtered ? <SearchX width={20} height={20} /> : <Library width={20} height={20} />}</span>}
    {(filtered || noSources) && <h2>{filtered ? t('catalogue:empty.filtered.title') : t('catalogue:empty.noSources.title')}</h2>}
    <p>{criteria}</p>
    {filtered && <div className="catalogue-actions">
      {view?.query.trim() && <Button size="sm" onClick={() => view.setQuery('')}>{t('catalogue:empty.filtered.remove', { filter: view.query })}</Button>}
      {empty.filters.map((item, index) => <Button key={`${item.family}-${index}`} size="sm" onClick={() => view.dispatch({ type: 'remove', family: item.family })}>{t('catalogue:empty.filtered.remove', { filter: summaryLabel(item) })}</Button>)}
      {empty.actionKey && <Button variant="ghost" size="sm" onClick={action}>{t(empty.actionKey)}</Button>}
    </div>}
    {!filtered && empty.actionKey && <Button variant="primary-violet" onClick={action}>{t(empty.actionKey)}</Button>}
  </section>;
}
