import { CatalogueActions } from '../CatalogueActions.jsx';
import { Button } from '../../common/Button.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { operationView } from '../../../store/catalogue/operationView.js';
// `embedded` : le détail d'une entrée de la pastille d'activité.
export function ScanTracker({ snapshot, onCancel, onClose, compact = false, embedded = false }) {
  const { t, line } = useCatalogueTranslation();
  const view = operationView(snapshot);
  const reasonId = `cancel-reason-${view.operationId}`;
  if (embedded) return <>
    <p className="validation-pill-details-text">{line(view.progressLine)}</p>
    {view.isScan && <p className="validation-pill-details-text">{line(view.rootsLine)}</p>}
    {view.currentDirectory && <p className="validation-pill-details-text catalogue-path">{view.currentDirectory}</p>}
    {view.progress.total !== null && <progress className="validation-pill-details-progress" value={view.progress.analysed} max={Math.max(1, view.progress.total)} aria-label={t('catalogue:tracker.analysis.label')} />}
    <div className="validation-pill-details-actions">
      <Button size="sm" aria-disabled={view.status === 'cancelling'} aria-describedby={view.status === 'cancelling' ? reasonId : undefined} onClick={() => view.status !== 'cancelling' && onCancel(view.operationId)}>{t('catalogue:tracker.cancel.label')}</Button>
    </div>
    {view.status === 'cancelling' && <p id={reasonId} className="validation-pill-details-text">{t('catalogue:progress.status.cancelling')}</p>}
  </>;
  return <section className="catalogue-panel" aria-label={line(view.title)}>
    <h2>{line(view.title)}</h2>
    <p>{line(view.progressLine)}</p>{view.isScan && <p>{line(view.rootsLine)}</p>}
    {view.currentDirectory && <p className="catalogue-path">{view.currentDirectory}</p>}
    {view.progress.total !== null && <progress value={view.progress.analysed} max={Math.max(1, view.progress.total)} aria-label={t('catalogue:tracker.analysis.label')} />}
    <CatalogueActions>
      <button type="button" aria-disabled={view.status === 'cancelling'} aria-describedby={view.status === 'cancelling' ? reasonId : undefined} onClick={() => view.status !== 'cancelling' && onCancel(view.operationId)}>{t('catalogue:tracker.cancel.label')}</button>
      {!compact && <button type="button" onClick={() => onClose(view.operationId)}>{t('catalogue:tracker.close.label')}</button>}
    </CatalogueActions>
    {view.status === 'cancelling' && <p id={reasonId}>{t('catalogue:progress.status.cancelling')}</p>}
    {!compact && <p>{t('catalogue:tracker.close.help')}</p>}
  </section>;
}
