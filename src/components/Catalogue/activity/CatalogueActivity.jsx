import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StatusPill, StatusPillEntry } from '../../layout/StatusPill.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { Broom } from '../../icons/LucideLocal.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { operationView } from '../../../store/catalogue/operationView.js';
import { activityDismissals, activityGroup, activityPill, idsSignature, visibleActivity } from '../../../store/catalogue/activityModel.js';
import { ScanSummary } from '../operations/ScanSummary.jsx';
import { ScanTracker } from '../operations/ScanTracker.jsx';
import { latestRecovery, recoveryMessage } from '../open/ResumeBanner.jsx';
import { luniiSendEntries } from './LuniiSendItems.jsx';
import { luniiQueueEntries } from './LuniiQueueReport.jsx';
import { heldByEngine } from '../../../store/catalogue/luniiQueueView.js';
import { queueCoversSend, sendOpenKeys } from '../../../store/catalogue/luniiSend.js';

const GROUP_LABELS = { issue: 'catalogue:activity.group.issue', progress: 'catalogue:activity.group.progress', info: 'catalogue:activity.group.info' };

export function sendKeepsActivityOpen(sendSignature, input, endedIds) {
  return sendSignature.some(key => key.startsWith('attention:')) || endedIds.some(id => queueCoversSend(input.sends?.contextFor(id), input.luniiQueue?.entries));
}

/**
 * Les éléments de l'activité, au gabarit des corrections de l'éditeur. Un
 * souci mène, quand c'est possible, là où il se règle et disparaît une fois
 * réglé ; une information s'efface par sa croix.
 */
export function activityItems(t, line, input) {
  const items = [];
  for (const entry of input.errors ?? []) {
    if (entry.queueEntryId) continue; // Its interrupted send is told by the queue report.
    const message = presentCatalogueError(entry.error);
    // A Lunii that stopped and is still held by the engine cannot be ejected: the advice is to unplug it.
    const held = heldByEngine(entry.error);
    items.push({
      key: `error:${message.message}`, kind: 'error', tone: 'issue', label: entry.orphanConflict ? t('catalogue:lunii.conflict') : held ? t('catalogue:lunii.unresponsiveHeld') : message.message,
      signature: entry.onDismiss ? null : `error:${message.message}`,
      onSelect: entry.onSelect ?? null, onDismiss: entry.onDismiss ?? (entry.onSelect ? null : undefined),
      detail: entry.orphanConflict ? <Button size="sm" onClick={entry.onSelect}>{t('catalogue:lunii.seeOrphan')}</Button> : message.technicalDetail ? <p className="validation-pill-details-text">{message.technicalDetail}</p> : null,
    });
  }
  const missing = input.missing ?? [];
  if (missing.length > 0) items.push({
    key: 'missing', kind: 'missing', tone: 'issue', signature: idsSignature('missing', missing.map((card) => card.id)),
    label: t('catalogue:activity.missing', { count: missing.length }), onSelect: input.onShowMissing,
    detail: <div className="validation-pill-details-actions"><Button size="sm" disabled={input.removing} onClick={input.onRemoveMissing}>{t('catalogue:header.removeMissing')}</Button></div>,
  });
  for (const snapshot of input.running ?? []) if (snapshot.operationKind !== 'luniiSend') items.push({
    key: `running:${snapshot.operationId}`, kind: 'running', tone: 'progress', signature: null, onDismiss: null,
    label: line(operationView(snapshot).title),
    detail: <ScanTracker embedded snapshot={snapshot} onCancel={input.onCancel} />,
  });
  for (const snapshot of input.summaries ?? []) if (snapshot.operationKind !== 'luniiSend') items.push({
    key: `summary:${snapshot.operationId}`, kind: 'summary', tone: operationView(snapshot).hasIssues ? 'issue' : 'success', signature: null,
    label: line(operationView(snapshot).title), onDismiss: () => input.onDismissSummary?.(snapshot.operationId),
    detail: <ScanSummary embedded snapshot={snapshot} api={input.api} onClose={input.onDismissSummary} onShowAdditions={input.onShowAdditions} />,
  });
  items.push(...luniiSendEntries(t, line, input));
  items.push(...luniiQueueEntries(t, input));
  if (input.sourceNotice) items.push({
    key: 'sources', kind: 'sources', tone: 'info', signature: `sources:${JSON.stringify(input.sourceNotice)}`,
    label: line(input.sourceNotice), onSelect: input.onPreferences,
  });
  if (input.browserNotice) items.push({
    key: 'notice', kind: 'notice', tone: 'info', signature: null,
    label: line(input.browserNotice), onDismiss: input.onDismissBrowserNotice,
  });
  const recoveries = input.recoveries ?? [];
  const latest = latestRecovery(recoveries);
  if (latest) items.push({
    key: 'resume', kind: 'resume', tone: 'info', signature: idsSignature('resume', recoveries.map((item) => `${item.snapshotPath ?? ''}@${item.modifiedAtMs ?? ''}`)),
    label: recoveryMessage(t, recoveries, latest),
    detail: <div className="validation-pill-details-actions">
      <Button size="sm" onClick={() => input.onRecoverSession?.(latest)}>{t('catalogue:startup.resume.action')}</Button>
      <Button size="sm" onClick={() => input.onIgnoreSessionRecovery?.(latest)}>{t('catalogue:startup.resume.ignore')}</Button>
    </div>,
  });
  return items;
}

export function CatalogueActivity({ fallbackFocusId = null, ...input }) {
  const { t, line } = useCatalogueTranslation();
  const dismissed = useSyncExternalStore(activityDismissals.subscribe, activityDismissals.snapshot, activityDismissals.snapshot);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const autoOpened = useRef(new Set());
  const transfers = [...(input.running ?? []), ...(input.summaries ?? [])].filter(s => s.operationKind === 'luniiRepatriate');
  // A transfer opens the pill at its start and again if something did not leave; it never takes the focus.
  const sendSignature = sendOpenKeys([...(input.running ?? []), ...(input.summaries ?? [])].filter(snapshot => !queueCoversSend(input.sends?.contextFor(snapshot.operationId), input.luniiQueue?.entries)), id => input.sends?.contextFor(id) ?? null, input.sends?.contexts ?? []);
  const autoSignature = [...transfers.map(s => s.operationId), ...sendSignature, ...(input.errors ?? []).filter(e => !e.queueEntryId && e.error?.code?.startsWith('STORYTELLER_')).map(e => `error:${e.error.code}`), ...(input.browserNotice?.key === 'catalogue:lunii.repairResult' ? [JSON.stringify(input.browserNotice)] : []), ...(input.luniiQueue?.reports ?? []).map(report => `queue-report:${report.run}`)].join('|');
  const runningSends = (input.running ?? []).filter(s => s.operationKind === 'luniiSend').map(s => s.operationId).join('|');
  const previousSends = useRef('');
  useEffect(() => {
    const current = new Set(autoSignature.split('|').filter(Boolean));
    const fresh = [...current].some(key => !autoOpened.current.has(key));
    autoOpened.current = current;
    if (fresh) setOpen(true);
  }, [autoSignature]);
  // The end of a smooth transfer closes the pill; the entries stay as its bilan.
  useEffect(() => {
    const endedIds = previousSends.current.split('|').filter(Boolean).filter(id => !runningSends.split('|').includes(id));
    previousSends.current = runningSends;
    if (endedIds.length && !sendKeepsActivityOpen(sendSignature, input, endedIds)) setOpen(false);
  // reason: only the set of running sends decides.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningSends]);
  const focusInside = useRef(false);
  const items = visibleActivity(activityItems(t, line, input), dismissed);
  const pill = activityPill(items);

  // La pastille disparaît quand il n'y a plus rien : le focus qu'elle tenait
  // revient au menu du Catalogue au lieu de se perdre.
  useEffect(() => {
    if (pill) return;
    setOpen(false);
    if (focusInside.current) {
      focusInside.current = false;
      if (fallbackFocusId) document.querySelector(`[data-toolbar-id="${fallbackFocusId}"]`)?.focus();
    }
  }, [pill, fallbackFocusId]);

  if (!pill) return null;

  const close = () => setOpen(false);
  const select = (callback) => () => { close(); callback?.(); };
  const dismiss = (item) => () => {
    if (item.onDismiss) item.onDismiss(); else activityDismissals.dismiss(item.signature);
    // La croix disparaît avec son entrée : le focus revient à la pastille.
    wrapRef.current?.querySelector('.validation-pill')?.focus();
  };
  const dismissible = (item) => item.onDismiss !== null && (item.onDismiss || item.signature);
  // Balai : efface d'un coup, pour la session, toutes les entrées qui ont leur croix.
  const clearable = items.filter(dismissible);
  const clearAll = () => {
    for (const item of clearable) {
      if (item.onDismiss) item.onDismiss(); else activityDismissals.dismiss(item.signature);
    }
    wrapRef.current?.querySelector('.validation-pill')?.focus();
  };
  const label = t(pill.label);
  const total = t('catalogue:header.activity', { count: items.length });
  return (
    <span
      className={`catalogue-activity-anchor catalogue-activity--${items.some(item => item.kind === 'error') ? 'danger' : items.some(item => item.tone === 'issue') ? 'warning' : 'info'}`}
      onFocusCapture={() => { focusInside.current = true; }}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) focusInside.current = false; }}
    >
      <StatusPill
        state={pill.state}
        open={open}
        onOpenChange={setOpen}
        tooltip={total}
        label={label}
        count={pill.count}
        toolbarId="catalogueActivity"
        popoverLabel={total}
        title={t('catalogue:activity.title')}
        subtitle={t('catalogue:activity.subtitle', { count: items.length })}
        wrapRef={wrapRef}
        dropdownClassName="catalogue-activity"
        restoreFocusOnEscape
        keepOpen={runningSends !== ''}
        headerAction={clearable.length >= 2 ? (
          <Tooltip text={t('catalogue:activity.dismissAll')} asChild>
            <button type="button" className="validation-pill-item-dismiss" onClick={clearAll} aria-label={t('catalogue:activity.dismissAll')}>
              <Broom width={14} height={14} strokeWidth={2} />
            </button>
          </Tooltip>
        ) : null}
      >
        {['issue', 'progress', 'info'].map((group) => {
          const members = items.filter((item) => activityGroup(item.tone) === group);
          if (members.length === 0) return null;
          return (
            <div key={group} className="validation-pill-group">
              <div className="validation-pill-group-head">
                <span className="validation-pill-group-label">{t(GROUP_LABELS[group])}</span>
                <span className="validation-pill-group-count">· {members.length}</span>
              </div>
              {members.map((item) => {
                // `onDismiss: null` : un souci qui se règle ailleurs, ou un
                // travail en cours, ne s'efface pas.
                return (
                  <StatusPillEntry
                    key={item.key}
                    tone={item.tone}
                    label={item.label}
                    onSelect={item.onSelect ? select(item.onSelect) : null}
                    onDismiss={dismissible(item) ? dismiss(item) : null}
                    dismissLabel={t('catalogue:activity.dismiss')}
                  >
                    {item.detail}
                  </StatusPillEntry>
                );
              })}
            </div>
          );
        })}
      </StatusPill>
    </span>
  );
}
