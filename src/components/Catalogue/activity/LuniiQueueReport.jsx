import i18next from 'i18next';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { useMessageLanguage } from '../../../i18n/useMessageLanguage.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { LuniiSendBilan } from './LuniiSendItems.jsx';

function list(values, language) {
  try { return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(values.map(String)); } catch { return values.join(', '); }
}

/** What an entry was, in the words of the report. */
export function queueKindLabel(t, entry) {
  switch (entry.kind) {
    case 'send': return t('catalogue:lunii.queueReport.kind.send');
    case 'repatriate': return t('catalogue:lunii.queueReport.kind.repatriate');
    case 'remove': return t('catalogue:lunii.queueReport.kind.remove');
    case 'orphan': return entry.args?.[0]?.restore ? t('catalogue:lunii.queueReport.kind.putBack') : t('catalogue:lunii.queueReport.kind.delete');
    case 'restoreOrphans': return t('catalogue:lunii.queueReport.kind.putBack');
    case 'hide': return entry.args?.[1] === false ? t('catalogue:lunii.queueReport.kind.show') : t('catalogue:lunii.queueReport.kind.hide');
    case 'nameStory': return t('catalogue:lunii.queueReport.kind.name');
    case 'reorder': return t('catalogue:lunii.queueReport.kind.move');
    case 'rename': return t('catalogue:lunii.queueReport.kind.rename');
    case 'repair': return t('catalogue:lunii.queueReport.kind.repair');
    case 'restore': return t('catalogue:lunii.queueReport.kind.restore');
    default: return t('catalogue:lunii.queueReport.kind.other');
  }
}

/** Why the queue stopped before these entries: unplugged, or a fault of the Lunii. */
export function queueStopReason(t, stop) {
  if (!stop) return null;
  const code = stop.userMessage?.code ?? stop.code;
  if (code === 'STORYTELLER_DEVICE_GONE') return t('catalogue:lunii.queueReport.stoppedGone');
  return t('catalogue:lunii.queueReport.stoppedFault', { reason: presentCatalogueError(stop).message });
}

/** Done, failed (with why), not started (with why the queue stopped), removals cancelled by a failed repatriation. */
export function LuniiQueueReport({ report, handlers }) {
  const { t } = useCatalogueTranslation();
  useMessageLanguage();
  const language = i18next.resolvedLanguage ?? 'fr';
  const item = entry => entry.title ? t('catalogue:lunii.queueReport.item', { kind: queueKindLabel(t, entry), title: entry.title }) : queueKindLabel(t, entry);
  return <div className="catalogue-activity-summary">
    <p className="validation-pill-details-text">{t('catalogue:lunii.queueReport.counts', { done: report.done, failed: report.failed.length, notStarted: report.notStarted.length })}</p>
    {report.failed.length > 0 && <ul className="validation-pill-details-list" aria-label={t('catalogue:lunii.queueReport.failedList')}>
      {report.failed.map(entry => <li key={entry.id}><strong>{item(entry)}</strong> {entry.sendInterruption
        ? <LuniiSendBilan report={entry.sendInterruption} handlers={handlers} />
        : <span>{presentCatalogueError(entry.reason).message}</span>}</li>)}
    </ul>}
    {report.notStarted.length > 0 && <>
      <p className="validation-pill-details-text">{queueStopReason(t, report.stop)}</p>
      <ul className="validation-pill-details-list" aria-label={t('catalogue:lunii.queueReport.notStartedList')}>{report.notStarted.map(entry => <li key={entry.id}>{item(entry)}</li>)}</ul>
    </>}
    {report.excluded.length > 0 && <p className="validation-pill-details-text">{t('catalogue:lunii.queueReport.excluded', { count: report.excluded.length, titles: list(report.excluded.map(e => e.title || t('catalogue:lunii.untitled')), language) })}</p>}
  </div>;
}

/** One activity entry per report; its cross closes it for the session. */
export function luniiQueueEntries(t, input) {
  const queue = input.luniiQueue;
  if (!queue) return [];
  return (queue.reports ?? []).filter(report => {
    const entries = queue.entries?.[report.deviceId]?.filter(entry => entry.run === report.run);
    return !(entries?.length === 1 && entries[0].sendInterruption);
  }).map(report => ({
    key: `queue-report:${report.run}`, kind: 'summary', tone: 'issue', signature: null,
    label: t('catalogue:lunii.queueReport.title', { name: report.deviceName || t('catalogue:lunii.name') }),
    onDismiss: () => queue.onDismiss?.(report.deviceId, report.run),
    detail: <LuniiQueueReport report={report} handlers={input.sends?.handlers} />,
  }));
}
