import { BackupExportSummary } from './BackupExportSummary.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { canExport, EXPORT_BUSY } from '../../../store/catalogue/backupExportState.js';
import { CatalogueDataDialog } from '../CatalogueDataDialog.jsx';
import './ExportDialog.css';
export function ExportDialog({ flow, onChoosePath }) {
  const { t } = useCatalogueTranslation();
  const { state, dispatch } = flow;
  const busy = EXPORT_BUSY.has(state.phase);
  const summary = state.plan ? { ...state.plan.counts, bytes: state.plan.estimatedBytes } : {};
  return <CatalogueDataDialog label={t('catalogue:backupExport.title')} busy={busy} onClose={() => dispatch({ type: 'close' })}>
    <div className="catalogue-backup-export">
    <h2>{t('catalogue:backupExport.title')}</h2>
    <p id="catalogue-export-description">{t('catalogue:backupExport.description')}</p>
    <label>{t('catalogue:backupExport.destination')}<input value={state.path} readOnly={busy} aria-describedby="catalogue-export-description" onChange={event => dispatch({ type: 'path', path: event.target.value })} /></label>
    <button type="button" aria-disabled={busy || undefined} aria-describedby={busy ? 'catalogue-export-busy' : undefined} onClick={() => { if (!busy) void onChoosePath(); }}>{t('catalogue:backupExport.browse')}</button>
    <p id="catalogue-export-requirement">{t('catalogue:backupExport.previewRequirement')}</p>
    <button type="button" aria-disabled={busy || !state.path.trim() || undefined} aria-describedby={busy ? 'catalogue-export-busy' : 'catalogue-export-requirement'} onClick={() => { if (!busy && state.path.trim()) void flow.preview(); }}>{t('catalogue:backupExport.preview')}</button>
    {state.plan && <section aria-label={t('catalogue:backupExport.summary')}>
      <p className="catalogue-backup-path">{state.plan.destinationPath}</p>
      <p>{t('catalogue:backupExport.counts', summary)}</p>
      {state.plan.conflicts.length > 0 && <label><input type="checkbox" checked={state.replaceExisting} disabled={busy} onChange={event => dispatch({ type: 'replace', value: event.target.checked })} />{t('catalogue:backupExport.replace')}</label>}
      <label><input type="checkbox" checked={state.summaryValidated} disabled={busy} onChange={event => dispatch({ type: 'summary', value: event.target.checked })} />{t('catalogue:backupExport.confirm')}</label>
      <p id="catalogue-export-confirm-reason">{t('catalogue:backupExport.confirmRequirement')}</p>
      <button type="button" aria-disabled={!canExport(state) || undefined} aria-describedby="catalogue-export-confirm-reason" onClick={() => { if (canExport(state)) void flow.start(); }}>{t('catalogue:backupExport.start')}</button>
    </section>}
    <div aria-live="polite" aria-atomic="true">
      {busy && <p id="catalogue-export-busy" role="status">{t('catalogue:backupExport.busy')}</p>}
      {state.error && <p role="alert">{presentCatalogueError(state.error).message}</p>}
      {state.phase === 'cancelled' && <p>{t('catalogue:backupExport.cancelled')}</p>}
      {state.phase === 'success' && <BackupExportSummary result={state.result} />}
    </div>
    {['running', 'cancelling'].includes(state.phase) && <button type="button" aria-disabled={state.phase === 'cancelling' || undefined} aria-describedby="catalogue-export-busy" onClick={() => { if (state.phase === 'running') void flow.cancel(); }}>{t('catalogue:backupExport.cancel')}</button>}
    <button type="button" aria-disabled={busy || undefined} aria-describedby={busy ? 'catalogue-export-busy' : undefined} onClick={() => { if (!busy) dispatch({ type: 'close' }); }}>{t('catalogue:backupExport.close')}</button>
    </div>
  </CatalogueDataDialog>;
}
