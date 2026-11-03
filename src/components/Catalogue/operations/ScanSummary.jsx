import { OperationIssues } from './OperationIssues.jsx';
import { ImportSummary } from '../backup/ImportSummary.jsx';
import { importResult } from '../../../store/catalogue/importPreviewState.js';
import { BackupExportSummary } from '../backup/BackupExportSummary.jsx';
import { backupResultForSummary } from '../../../store/catalogue/backupExportState.js';
import { CatalogueActions } from '../CatalogueActions.jsx';
import { useEffect, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { createSummaryTimer, operationView } from '../../../store/catalogue/operationView.js';
import { CatalogueNotice } from '../CatalogueNotice.jsx';
import { Button } from '../../common/Button.jsx';
// `embedded` : le détail d'une entrée de la pastille d'activité, sans titre ni
// bouton de fermeture (la croix de l'entrée ferme le bilan).
export function ScanSummary({ snapshot, api, onClose, onShowAdditions, embedded = false }) {
  const { t, line } = useCatalogueTranslation();
  const view = operationView(snapshot);
  let imported = null;
  if (snapshot?.status === 'success' && snapshot.result?.reportId) {
    try { imported = importResult(snapshot.result); } catch { /* Another operation result. */ }
  }
  const backup = backupResultForSummary(snapshot);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => {
    // Create in the effect so StrictMode can dispose and reinstall safely.
    const timer = createSummaryTimer({ duration: view.lifetime, expire: () => onClose?.(view.operationId) });
    timerRef.current = timer;
    timer.resume();
    return () => timer.dispose();
  }, [view.lifetime, view.operationId, onClose]);
  useEffect(() => {
    const timer = timerRef.current;
    if (hovered || focused) timer?.pause(); else timer?.resume();
    return () => timer?.pause();
  }, [hovered, focused, view.lifetime, view.operationId, onClose]);
  const pause = { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false), onFocus: () => setFocused(true), onBlur: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); } };
  const reasons = (item) => item.counter && view.breakdown[item.counter]?.items.length > 0 && <ul>{view.breakdown[item.counter].items.map((reason) => <li key={reason.reason}>{t('catalogue:summary.reason.count', { count: reason.count, reason: t(reason.reasonKey) })}</li>)}</ul>;
  const names = item => item.names?.length > 0 && <ul className="catalogue-operation-names">
    {item.names.map((name, index) => <li key={index}>{name}</li>)}
    {item.remaining > 0 && <li>{t('catalogue:operation.moreNames', { count: item.remaining })}</li>}
  </ul>;
  if (embedded) return <div className="catalogue-activity-summary" {...pause}>
    <ul className="validation-pill-details-list">{view.lines.map((item) => <li key={item.key}>{line(item)}{names(item)}{reasons(item)}</li>)}</ul>
    {view.isScan && <p className="validation-pill-details-text">{t('catalogue:summary.metadata.help')}</p>}
    <CatalogueNotice error={view.error} />
    {view.hasIssueItems && <OperationIssues operationId={view.operationId} snapshot={snapshot} api={api} />}
    {backup && <BackupExportSummary result={backup} />}
    {imported && <ImportSummary result={imported} />}
    {view.isScan && view.counts.indexedNew > 0 && <div className="validation-pill-details-actions">
      <Button size="sm" onClick={() => onShowAdditions?.(view.operationId)}>{t('catalogue:summary.additions.show')}</Button>
    </div>}
  </div>;
  return <section className="catalogue-panel" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <h2>{line(view.title)}</h2>
    <ul>{view.lines.map((item) => <li key={item.key}>{line(item)}{names(item)}
      {item.counter && view.breakdown[item.counter]?.items.length > 0 && <ul>{view.breakdown[item.counter].items.map((reason) => <li key={reason.reason}>{t('catalogue:summary.reason.count', { count: reason.count, reason: t(reason.reasonKey) })}</li>)}</ul>}
    </li>)}</ul>
    {view.isScan && <p>{t('catalogue:summary.metadata.help')}</p>}
    <CatalogueNotice error={view.error} />
    {view.hasIssueItems && <OperationIssues operationId={view.operationId} snapshot={snapshot} api={api} />}
    {backup && <BackupExportSummary result={backup} />}
    {imported && <ImportSummary result={imported} />}
    <CatalogueActions>
      {view.isScan && view.counts.indexedNew > 0 && <button type="button" onClick={() => onShowAdditions?.(view.operationId)}>{t('catalogue:summary.additions.show')}</button>}
      <button type="button" onClick={() => onClose(view.operationId)}>{t('catalogue:summary.close.label')}</button>
    </CatalogueActions>
  </section>;
}
