import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { IMPORT_BUSY, canApplyImport } from '../../../store/catalogue/importPreviewState.js';
import { CatalogueDataDialog } from '../CatalogueDataDialog.jsx';
import { Select } from '../../common/Select.jsx';
import { ImportConflictRow } from './ImportConflictRow.jsx';
import { UnresolvedAssociations } from './UnresolvedAssociations.jsx';
import { importKindLabel, importValueLines } from '../../../store/catalogue/importConflictPresentation.js';
import { ImportSummary } from './ImportSummary.jsx';
import './ImportDialog.css';
export function ImportDialog({ flow, onChoosePath, candidates = [] }) {
  const { t } = useCatalogueTranslation();
  const { state, dispatch } = flow; const busy = IMPORT_BUSY.has(state.phase); const preview = state.preview;
  const total = preview ? Math.max(...['additions', 'changes', 'conflicts', 'unresolved'].map(k => preview[k].total)) : 0;
  return <CatalogueDataDialog label={t('catalogue:backupImport.title')} busy={busy} onClose={() => dispatch({ type: 'close' })}>
    <div className="catalogue-backup-import"><h2>{t('catalogue:backupImport.title')}</h2>
      <p id="catalogue-import-help">{t('catalogue:backupImport.description')}</p>
      <label>{t('catalogue:backupImport.path')}<input value={state.path} readOnly={busy} aria-describedby="catalogue-import-help" onChange={e => dispatch({ type: 'path', path: e.target.value })} /></label>
      <button type="button" aria-disabled={busy || undefined} aria-describedby="catalogue-import-help" onClick={() => { if (!busy) void onChoosePath(); }}>{t('catalogue:backupImport.browse')}</button>
      <button type="button" aria-disabled={busy || !state.path.trim() || undefined} aria-describedby="catalogue-import-help" onClick={() => { if (!busy && state.path.trim()) void flow.preview(); }}>{t('catalogue:backupImport.preview')}</button>
      {preview && state.phase === 'preview' && <>
        <p>{preview.forgottenCount > 0
          ? t('catalogue:backupImport.countsWithForgetting', { additions: preview.additions.total, changes: preview.changes.total, conflicts: preview.conflicts.total, unresolved: preview.unresolved.total, count: preview.forgottenCount })
          : t('catalogue:backupImport.counts', { additions: preview.additions.total, changes: preview.changes.total, conflicts: preview.conflicts.total, unresolved: preview.unresolved.total })}</p>
        <label>{t('catalogue:backupImport.global')}<Select value={state.globalChoice} onChange={choice => dispatch({ type: 'global', choice })} options={[
          { value: 'local', label: t('catalogue:backupImport.keepLocal') }, { value: 'incoming', label: t('catalogue:backupImport.useIncoming') },
        ]} /></label>
        {preview.conflicts.items.map(conflict => <ImportConflictRow key={conflict.id} conflict={conflict} state={state} dispatch={dispatch} />)}
        <section><h3>{t('catalogue:backupImport.details')}</h3><ul>{[...preview.additions.items, ...preview.changes.items].map(item => <li key={item.id}>
          <p>{t('catalogue:backupImport.conflict', { target: item.label || t('catalogue:card.untitled'), field: importKindLabel(t, item.kind, item.incoming?.field) })}</p>
          {importValueLines(t, item.kind, item.incoming).map((line, index) => <p key={index}>{line}</p>)}
        </li>)}</ul></section>
        <UnresolvedAssociations candidates={candidates} items={preview.unresolved.items} associations={state.associations} dispatch={dispatch} />
        {preview.issues.length > 0 && <p>{t('catalogue:backupImport.retainedEvidence')}</p>}
        <nav aria-label={t('catalogue:backupImport.pages')}>
          <button type="button" aria-disabled={preview.offset === 0 || undefined} aria-describedby="catalogue-import-page" onClick={() => { if (preview.offset) void flow.page(Math.max(0, preview.offset - 100)); }}>{t('catalogue:backupImport.previous')}</button>
          <span id="catalogue-import-page">{t('catalogue:backupImport.page', { start: Math.min(total, preview.offset + 1), end: Math.min(total, preview.offset + 100), total })}</span>
          <button type="button" aria-disabled={preview.offset + 100 >= total || undefined} aria-describedby="catalogue-import-page" onClick={() => { if (preview.offset + 100 < total) void flow.page(preview.offset + 100); }}>{t('catalogue:backupImport.next')}</button>
        </nav>
        <p id="catalogue-import-revalidate">{t('catalogue:backupImport.revalidate')}</p>
        <button type="button" aria-disabled={!canApplyImport(state) || undefined} aria-describedby="catalogue-import-revalidate" onClick={() => { if (canApplyImport(state)) void flow.apply(); }}>{t('catalogue:backupImport.apply')}</button>
      </>}
      <div aria-live="polite" aria-atomic="true">
        {busy && <p role="status" id="catalogue-import-busy">{t('catalogue:backupImport.busy')}</p>}
        {state.error && <p role="alert">{presentCatalogueError(state.error).message}</p>}
        {state.phase === 'cancelled' && <p>{t('catalogue:backupImport.cancelled')}</p>}
        {state.phase === 'success' && <ImportSummary result={state.result} />}
      </div>
      {['preparing', 'applying', 'cancelling'].includes(state.phase) && <button type="button" aria-disabled={!state.receipt || state.phase === 'cancelling' || undefined} aria-describedby="catalogue-import-busy" onClick={() => { if (state.receipt && state.phase !== 'cancelling') void flow.cancel(); }}>{t('catalogue:backupImport.cancel')}</button>}
      <button type="button" aria-disabled={busy || undefined} aria-describedby={busy ? 'catalogue-import-busy' : undefined} onClick={() => { if (!busy) dispatch({ type: 'close' }); }}>{t('catalogue:backupImport.close')}</button>
    </div>
  </CatalogueDataDialog>;
}
