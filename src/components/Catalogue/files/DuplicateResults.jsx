import { useCatalogueDuplicates } from '../../../hooks/useCatalogueDuplicates.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { CatalogueDataDialog } from '../CatalogueDataDialog.jsx';
export function DuplicateResults({ results, cards = [] }) {
  const { t } = useCatalogueTranslation();
  const exemplars = new Map(cards.flatMap(card => (card.exemplars ?? []).map(e => [e.id, e])));
  const names = ids => <ul>{ids.map(id => <li key={id}><span className="catalogue-path">{exemplars.get(id)?.path ?? id}</span>{exemplars.get(id)?.member && <span className="catalogue-path">{exemplars.get(id).member}</span>}</li>)}</ul>;
  return <div>
    <h4>{t('catalogue:diagnostics.exact')}</h4>
    {!results.exactGroups.length && <p>{t('catalogue:diagnostics.none')}</p>}
    {results.exactGroups.map(group => <section key={group.digest}><code>{group.digest}</code>{names(group.exemplarIds)}</section>)}
    <h4>{t('catalogue:diagnostics.older')}</h4>
    <p>{t('catalogue:diagnostics.olderHint')}</p>
    {!results.olderVersions.length && <p>{t('catalogue:diagnostics.none')}</p>}
    {results.olderVersions.map(group => <section key={`${group.uuid}:${group.format}`}><p>{group.uuid} · {group.format}</p>{names(group.exemplarIds)}</section>)}
    <ul>{results.issues.map((issue, index) => <li key={index}>{exemplars.get(issue.exemplarId)?.path ?? issue.exemplarId}<p>{presentCatalogueError({ code: issue.code }).message}</p></li>)}</ul>
  </div>;
}
export function DuplicateDialog({ ficheId = null, cards, onClose }) {
  const { t } = useCatalogueTranslation(); const flow = useCatalogueDuplicates(ficheId); const { state } = flow;
  return <CatalogueDataDialog label={t('catalogue:diagnostics.duplicates')} onClose={onClose}>
    <h3>{t('catalogue:diagnostics.duplicates')}</h3>
    <p>{t('catalogue:diagnostics.onDemand')}</p>
    {state.error && <p role="alert">{presentCatalogueError(state.error).message}</p>}
    {state.phase === 'running' ? <><p role="status">{t('catalogue:files.running')}</p><button type="button" onClick={() => void flow.cancel()}>{t('catalogue:tracker.cancel.label')}</button></>
      : <button type="button" onClick={() => void flow.start()}>{t('catalogue:diagnostics.start')}</button>}
    {state.phase !== 'idle' && state.phase !== 'running' && <p role="status">{t('catalogue:files.finished')}</p>}
    {state.phase === 'success' && <DuplicateResults results={state.results} cards={cards} />}
    {state.results.cursor !== null && <button type="button" onClick={() => void flow.more()}>{t('catalogue:diagnostics.more')}</button>}
    <button type="button" onClick={onClose}>{t('catalogue:data.close')}</button>
  </CatalogueDataDialog>;
}
