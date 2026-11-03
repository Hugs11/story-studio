import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import i18next from 'i18next';
import { useMessageLanguage } from '../../../i18n/useMessageLanguage.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { operationView } from '../../../store/catalogue/operationView.js';
import { reportPositions, sendBilanKind, sendNowKey, sendProgress, sendReport, sendStepKey, sendTerminal } from '../../../store/catalogue/luniiSend.js';
import { Button } from '../../common/Button.jsx';
import { Loader2 } from '../../icons/LucideLocal.jsx';

function list(values, language) {
  try { return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(values.map(String)); } catch { return values.join(', '); }
}

/** Running transfer: counter, current story, progress and cancel. */
export function LuniiSendTracker({ snapshot, context, onCancel }) {
  const { t, line } = useCatalogueTranslation();
  const view = operationView(snapshot);
  const reasonId = `send-cancel-${view.operationId}`;
  if (!context) return <p className="validation-pill-details-text">{t('catalogue:lunii.sendNow.preparing')}</p>;
  const progress = sendProgress(context, snapshot);
  const current = progress.current;
  const untitled = t('catalogue:lunii.untitled');
  return <>
    <p className="validation-pill-details-text">{t('catalogue:lunii.sendProgress', { count: progress.total, done: Math.min(progress.total, progress.settled + (current ? 1 : 0)), total: progress.total, step: line({ key: sendNowKey(current?.step ?? 'preparing'), params: {} }) })}</p>
    {current && <p className="validation-pill-details-text lunii-send-current"><Loader2 className="lunii-spinner lunii-step-spinner" width={12} height={12} aria-hidden="true" /><span>{t('catalogue:lunii.sendCurrent', { title: current.title || untitled, step: line({ key: sendStepKey(current.step), params: { percent: current.progress } }) })}</span></p>}
    <progress className="validation-pill-details-progress" value={progress.percent} max={100} aria-label={t('catalogue:lunii.sendProgressLabel')} />
    <div className="validation-pill-details-actions">
      <Button size="sm" aria-disabled={progress.cancelling || undefined} aria-describedby={progress.cancelling ? reasonId : undefined} onClick={() => { if (!progress.cancelling) onCancel(view.operationId); }}>{t('catalogue:lunii.sendCancel')}</Button>
    </div>
    {progress.cancelling && <p id={reasonId} className="validation-pill-details-text">{t('catalogue:progress.status.cancelling')}</p>}
  </>;
}

/** Bilan: what left and where, what did not and why, then a cut and its leftovers. */
export function LuniiSendBilan({ report, handlers }) {
  const { t } = useCatalogueTranslation();
  useMessageLanguage();
  // Match the catalogue's French fallback before i18next is initialized;
  // undefined would select the host OS language for conjunctions.
  const language = i18next.resolvedLanguage ?? 'fr';
  const name = report.deviceName || t('catalogue:lunii.name');
  const untitled = t('catalogue:lunii.untitled');
  const positions = list(reportPositions(report), language);
  const titles = items => list(items.map(item => item.title || untitled), language);
  const notSent = report.refused.length + report.failed.length;
  const after = [];
  if (report.interrupted) after.push(t('catalogue:lunii.sendBilan.cut', { title: report.interrupted.title || untitled, name }));
  if (report.cancelled) after.push(t('catalogue:lunii.sendBilan.notStarted', { count: report.cancelled, titles: titles(report.notStarted) }));
  if (report.interrupted) after.push(t('catalogue:lunii.sendBilan.leftovers'));
  if (report.status === 'failed' && !report.done.length && !report.interrupted && !notSent) after.push(t('catalogue:lunii.sendBilan.failedHelp'));
  return <div className="catalogue-activity-summary">
    {report.done.length > 0 && <p className="validation-pill-details-text">{t('catalogue:lunii.sendBilan.sent', { count: report.done.length, titles: titles(report.done), name, positions })}</p>}
    {notSent > 0 && <LuniiSendRefusals report={report} handlers={handlers} />}
    {after.map(line => <p key={line} className="validation-pill-details-text">{line}</p>)}
    {report.warning && <p className="validation-pill-details-text">{t('catalogue:lunii.sendBilan.warning')}</p>}
  </div>;
}

/** One line per story that did not leave, with its reason and the follow-up. */
export function LuniiSendRefusals({ report, handlers }) {
  const { t, cell, line } = useCatalogueTranslation();
  const untitled = t('catalogue:lunii.untitled');
  return <ul className="validation-pill-details-list">{[...report.refused, ...report.failed].map(item => {
    const p = item.presentation;
    let reason;
    if (!p.key) reason = presentCatalogueError(p.reason ?? item.reason).message;
    else if (p.key === 'catalogue:lunii.sendRefused.noSpace') reason = p.bytes == null ? t('catalogue:lunii.sendRefused.noSpaceUnknown') : t('catalogue:lunii.sendRefused.noSpace', { size: cell(bytesCell(p.bytes)) });
    else if (p.key === 'catalogue:lunii.sendRefused.incomplete') reason = t('catalogue:lunii.sendRefused.incomplete', { cause: p.cause ? presentCatalogueError(p.cause).message : t('catalogue:lunii.sendRefused.incompleteUnknown') });
    else reason = line({ key: p.key, params: p.params });
    return <li key={`${item.exemplarId ?? item.ficheId}`}>
      <strong>{item.title || untitled}</strong> <span>{reason}</span>
      {p.action === 'see' && item.seeKey && <Button size="sm" onClick={() => handlers?.see(report.deviceId, item.seeKey)}>{t('catalogue:lunii.sendAction.see')}</Button>}
      {p.action === 'editor' && item.ficheId && <Button size="sm" onClick={() => handlers?.openEditor(item.ficheId)}>{t('catalogue:lunii.sendAction.editor')}</Button>}
    </li>;
  })}</ul>;
}

/**
 * Activity entries of the transfers: the running one, then a single bilan per
 * send. `local` contexts (nothing could be started) only carry refusals.
 */
export function luniiSendEntries(t, line, input) {
  const sends = input.sends;
  if (!sends) return [];
  const items = [];
  const nameOf = context => context?.deviceName || t('catalogue:lunii.name');
  for (const snapshot of input.running ?? []) {
    if (snapshot.operationKind !== 'luniiSend') continue;
    const context = sends.contextFor(snapshot.operationId);
    items.push({ key: `send-running:${snapshot.operationId}`, kind: 'running', tone: 'progress', signature: null, onDismiss: null,
      label: t('catalogue:lunii.sendTitle', { name: nameOf(context) }), detail: <LuniiSendTracker snapshot={snapshot} context={context} onCancel={input.onCancel} /> });
  }
  const bilanEntry = (id, context, report, onDismiss, signature) => {
    const bilan = sendBilanKind(report);
    items.push({ key: `send-bilan:${id}`, kind: 'summary', tone: bilan.tone, signature, onDismiss, label: line({ key: bilan.titleKey, params: {} }),
      detail: <LuniiSendBilan report={{ ...report, deviceId: context.deviceId }} handlers={sends.handlers} /> });
  };
  for (const snapshot of input.summaries ?? []) {
    if (snapshot.operationKind !== 'luniiSend' || !sendTerminal(snapshot)) continue;
    const context = sends.contextFor(snapshot.operationId);
    if (!context) continue;
    bilanEntry(snapshot.operationId, context, sendReport(context, snapshot, sends.devices), () => input.onDismissSummary?.(snapshot.operationId), null);
  }
  for (const context of sends.contexts.filter(c => c.local)) {
    const report = sendReport(context, null, sends.devices);
    if (!report.refused.length) continue;
    bilanEntry(context.operationId, context, report, () => input.onDismissLocal?.(context.operationId), `send-local:${context.operationId}`);
  }
  return items;
}
