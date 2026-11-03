import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { StatusPill, StatusPillItem } from './StatusPill';
import { useCheckerTranslation } from '../../i18n/useCheckerTranslation.js';
import './ValidationPill.css';

const AdvancedIssuesPanel = lazy(() => import('../AdvancedWorkspace/DiagnosticsPanel.jsx')
  .then((module) => ({ default: module.AdvancedIssuesPanel })));

export const ISSUE_KIND_HIERARCHICAL = 'hierarchical';
export const ISSUE_KIND_ADVANCED = 'advanced';

// Le séparateur « — » est porté par les gabarits de validation des trois
// langues ; aucun mot n'est reconnu. Le libellé du groupe sans emplacement est
// résolu au rendu.
function parseIssue(issue) {
  const text = issue?.text ?? '';
  const dashIdx = text.indexOf(' — ');
  if (dashIdx === -1) {
    return { groupKey: '__pack__', groupLabel: null, label: text };
  }
  const location = text.slice(0, dashIdx);
  return {
    groupKey: location,
    groupLabel: location,
    label: text.slice(dashIdx + 3),
  };
}

function buildGroups(issues) {
  const groupMap = new Map();
  issues.forEach((issue) => {
    const parsed = parseIssue(issue);
    let group = groupMap.get(parsed.groupKey);
    if (!group) {
      group = { key: parsed.groupKey, label: parsed.groupLabel, items: [] };
      groupMap.set(parsed.groupKey, group);
    }
    group.items.push({ issue, label: parsed.label });
  });
  const groups = [...groupMap.values()];
  const flat = [];
  groups.forEach((group) => {
    group.items.forEach((item) => {
      item.flatIndex = flat.length;
      flat.push(item);
    });
  });
  return { groups, flat };
}

export function ValidationPill({
  issueKind = ISSUE_KIND_HIERARCHICAL,
  validationIssues = [],
  advancedIssues = null,
  pathAuditPending = false,
  open,
  onOpenChange,
  onSelectIssue,
  onCountZeroTransition,
  shortcutLabel = '',
}) {
  const { t, language } = useCheckerTranslation();
  const advanced = issueKind === ISSUE_KIND_ADVANCED;
  const blockingIssues = useMemo(
    () => validationIssues.filter((issue) => issue?.status === 'error' || issue?.status === 'warning'),
    [validationIssues],
  );
  const advancedBlockingIssues = advancedIssues?.blockingIssues ?? [];
  const totalCount = advanced ? advancedBlockingIssues.length : blockingIssues.length;
  const pending = advanced
    ? pathAuditPending || advancedIssues == null || ['idle', 'pending'].includes(advancedIssues?.readiness?.status)
    : pathAuditPending;
  // La langue entre dans la mémoïsation : les textes des issues sont relus.
  const { groups, flat } = useMemo(() => buildGroups(blockingIssues), [blockingIssues, language]);

  const state = pending ? 'verifying' : totalCount > 0 ? 'issues' : 'ok';
  const isOpen = open && state !== 'verifying';
  const wrapRef = useRef(null);
  const dropdownRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!isOpen) setActiveIndex(0);
  }, [isOpen]);

  useEffect(() => {
    if (activeIndex > flat.length - 1) setActiveIndex(Math.max(0, flat.length - 1));
  }, [flat.length, activeIndex]);

  const prevTotalCountRef = useRef(totalCount);
  useEffect(() => {
    if (prevTotalCountRef.current > 0 && totalCount === 0) onCountZeroTransition?.();
    prevTotalCountRef.current = totalCount;
  }, [totalCount, onCountZeroTransition]);

  // Fermeture (Échap, clic extérieur) et survol : le socle commun. Ici, la
  // seule navigation clavier dans la liste.
  useEffect(() => {
    if (!isOpen || advanced) return undefined;
    function onKeyDown(event) {
      if (!wrapRef.current?.contains(event.target)) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (flat.length === 0 ? 0 : (index + 1) % flat.length));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (flat.length === 0 ? 0 : (index - 1 + flat.length) % flat.length));
      } else if (event.key === 'Enter') {
        const item = flat[activeIndex];
        if (item) {
          event.preventDefault();
          selectIssue(item.issue.id);
        }
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen, advanced, flat, activeIndex, onOpenChange, onSelectIssue]);

  useEffect(() => {
    if (!isOpen || advanced || !dropdownRef.current) return;
    const element = dropdownRef.current.querySelector(`[data-flat-idx="${activeIndex}"]`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, advanced, activeIndex]);

  const tooltipText = state === 'verifying'
    ? t('checker:pill.verifying.tooltip')
    : shortcutLabel
      ? t('checker:pill.count.tooltipShortcut', { count: totalCount, shortcut: shortcutLabel })
      : t('checker:pill.count.tooltip', { count: totalCount });
  const popoverSubtitle = totalCount === 0
    ? t('checker:pill.ready.subtitle')
    : t('checker:pill.blocking.subtitle', { count: totalCount });

  function selectIssue(issueId) {
    if (!issueId) return;
    onSelectIssue?.(issueId);
    onOpenChange?.(false);
  }

  return (
    <StatusPill
      state={state}
      open={open}
      onOpenChange={onOpenChange}
      tooltip={tooltipText}
      label={state === 'verifying' ? t('checker:pill.verifying.label') : t('checker:pill.count.label')}
      count={state === 'verifying' ? null : totalCount}
      toolbarId="toggleValidation"
      popoverLabel={t('checker:pill.list.aria')}
      title={t('checker:pill.list.title')}
      subtitle={popoverSubtitle}
      wrapRef={wrapRef}
      dropdownRef={dropdownRef}
    >
      {advanced ? (
        <Suspense fallback={<p className="validation-pill-empty">{t('checker:pill.loading.label')}</p>}>
          <AdvancedIssuesPanel
            context={advancedIssues}
            onRequestClose={() => onOpenChange?.(false)}
          />
        </Suspense>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.key} className="validation-pill-group">
              <div className="validation-pill-group-head">
                <span className="validation-pill-group-label">{group.label ?? t('checker:issues.pack.group')}</span>
                <span className="validation-pill-group-count">· {group.items.length}</span>
              </div>
              {group.items.map((item) => {
                const isActive = item.flatIndex === activeIndex;
                return (
                  <StatusPillItem
                    key={`${item.issue.id ?? 'noid'}:${item.flatIndex}`}
                    data-flat-idx={item.flatIndex}
                    active={isActive}
                    label={item.label}
                    onClick={() => selectIssue(item.issue.id)}
                    onMouseEnter={() => setActiveIndex(item.flatIndex)}
                  />
                );
              })}
            </div>
          ))}
          {blockingIssues.length === 0 && (
            <p className="validation-pill-empty">{t('checker:issues.empty')}</p>
          )}
        </>
      )}
    </StatusPill>
  );
}
