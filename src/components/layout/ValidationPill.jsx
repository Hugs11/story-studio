import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, TriangleAlert, CircleCheck, Loader2 } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import './ValidationPill.css';

const AdvancedIssuesPanel = lazy(() => import('../AdvancedWorkspace/DiagnosticsPanel.jsx')
  .then((module) => ({ default: module.AdvancedIssuesPanel })));

export const ISSUE_KIND_HIERARCHICAL = 'hierarchical';
export const ISSUE_KIND_ADVANCED = 'advanced';

// Le caret du bouton est un **glyphe plein**, pas une icône : il joue le rôle
// typographique d'un « ▾ » à 9 px, taille à laquelle le chevron tracé du jeu
// partagé rendrait un trait d'un demi-pixel. Il reste donc ici, et l'inventaire
// des jeux d'icônes le nomme avec cette raison. La flèche qui
// l'accompagnait, elle, redoublait la flèche du jeu partagé : elle a disparu.
const Caret = ({ size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path d="M1 3l4 4 4-4z" />
  </svg>
);

function parseIssue(issue) {
  const text = issue?.text ?? '';
  const dashIdx = text.indexOf(' — ');
  if (dashIdx === -1) {
    return { groupKey: '__pack__', groupLabel: 'Pack', label: text };
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
  const [severity, setSeverity] = useState('all');
  const shownIssues = useMemo(
    () => (severity === 'all'
      ? blockingIssues
      : blockingIssues.filter((issue) => issue.status === severity)),
    [blockingIssues, severity],
  );
  const { groups, flat } = useMemo(() => buildGroups(shownIssues), [shownIssues]);
  const severityCounts = useMemo(() => ({
    error: blockingIssues.filter((issue) => issue.status === 'error').length,
    warning: blockingIssues.filter((issue) => issue.status === 'warning').length,
  }), [blockingIssues]);

  const state = pending ? 'verifying' : totalCount > 0 ? 'issues' : 'ok';
  const isOpen = open && state !== 'verifying';
  const wrapRef = useRef(null);
  const dropdownRef = useRef(null);
  const closeTimerRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

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

  useEffect(() => {
    if (!isOpen) return undefined;
    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) onOpenChange?.(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange?.(false);
        return;
      }
      if (advanced || !wrapRef.current?.contains(event.target)) return;
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
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, advanced, flat, activeIndex, onOpenChange, onSelectIssue]);

  useEffect(() => {
    if (!isOpen || advanced || !dropdownRef.current) return;
    const element = dropdownRef.current.querySelector(`[data-flat-idx="${activeIndex}"]`);
    element?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, advanced, activeIndex]);

  const tooltipText = state === 'verifying'
    ? 'Vérification en cours…'
    : `${totalCount} élément${totalCount > 1 ? 's' : ''} à corriger${shortcutLabel ? ` (${shortcutLabel})` : ''}`;
  const popoverSubtitle = advanced
    ? `${totalCount} élément${totalCount > 1 ? 's' : ''} empêche${totalCount > 1 ? 'nt' : ''} la génération.`
    : severity === 'all'
      ? `${totalCount} élément${totalCount > 1 ? 's' : ''} dans le projet courant.`
      : `${shownIssues.length} affiché${shownIssues.length > 1 ? 's' : ''} sur ${totalCount}.`;

  function selectIssue(issueId) {
    if (!issueId) return;
    onSelectIssue?.(issueId);
    onOpenChange?.(false);
  }

  function handlePillClick() {
    if (state !== 'verifying') onOpenChange?.(!open);
  }

  function openPopover() {
    if (state === 'verifying') return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    onOpenChange?.(true);
  }

  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onOpenChange?.(false), 140);
  }

  return (
    <div
      className={`validation-pill-wrap ${isOpen ? 'is-open' : ''}`}
      ref={wrapRef}
      onPointerEnter={openPopover}
      onPointerLeave={scheduleClose}
      onMouseEnter={openPopover}
      onMouseLeave={scheduleClose}
      onFocus={openPopover}
    >
      <Tooltip text={tooltipText}>
        <button
          type="button"
          data-toolbar-id="toggleValidation"
          className={`validation-pill is-${state} ${isOpen ? 'is-active' : ''}`}
          onClick={handlePillClick}
          aria-haspopup={state === 'verifying' ? undefined : 'dialog'}
          aria-expanded={state === 'verifying' ? undefined : isOpen}
          aria-label={tooltipText}
        >
          {state !== 'verifying' ? (
            <>
              <span className={state === 'issues' ? 'validation-pill-icon' : 'validation-pill-check'}>
                {state === 'issues'
                  ? <TriangleAlert width={12} height={12} />
                  : <CircleCheck width={12} height={12} />}
              </span>
              <span className="validation-pill-count">{totalCount}</span>
              <span className="validation-pill-label">à corriger</span>
              <span className="validation-pill-caret"><Caret size={9} /></span>
            </>
          ) : (
            <>
              <span className="validation-pill-spinner"><Loader2 width={12} height={12} /></span>
              <span className="validation-pill-label">Vérification…</span>
            </>
          )}
        </button>
      </Tooltip>

      {isOpen ? (
        <>
          <div className="validation-pill-hover-bridge" aria-hidden="true" />
          <div
            className={`validation-pill-dd is-${state} ${advanced ? 'is-advanced' : ''}`}
            ref={dropdownRef}
            role="dialog"
            aria-label="Liste des éléments à corriger"
          >
            <div className="validation-pill-dd-head">
              <span className="validation-pill-dd-title">À corriger</span>
              <span className="validation-pill-dd-subtitle">{popoverSubtitle}</span>
            </div>
            <div className="validation-pill-dd-body">
              {advanced ? (
                <Suspense fallback={<p className="validation-pill-empty">Chargement…</p>}>
                  <AdvancedIssuesPanel
                    context={advancedIssues}
                    onRequestClose={() => onOpenChange?.(false)}
                  />
                </Suspense>
              ) : (
                <>
                  <div className="validation-pill-filters" role="group" aria-label="Filtrer par gravité">
                    <button type="button" aria-pressed={severity === 'all'} onClick={() => setSeverity('all')}>
                      Tous ({totalCount})
                    </button>
                    <button type="button" aria-pressed={severity === 'error'} onClick={() => setSeverity('error')}>
                      Erreurs ({severityCounts.error})
                    </button>
                    <button type="button" aria-pressed={severity === 'warning'} onClick={() => setSeverity('warning')}>
                      Avertissements ({severityCounts.warning})
                    </button>
                  </div>
                  {groups.map((group) => (
                    <div key={group.key} className="validation-pill-group">
                      <div className="validation-pill-group-head">
                        <span className="validation-pill-group-label">{group.label}</span>
                        <span className="validation-pill-group-count">· {group.items.length}</span>
                      </div>
                      {group.items.map((item) => {
                        const isActive = item.flatIndex === activeIndex;
                        const severityLabel = item.issue.status === 'error' ? 'Erreur' : 'Avertissement';
                        return (
                          <button
                            type="button"
                            key={`${item.issue.id ?? 'noid'}:${item.flatIndex}`}
                            data-flat-idx={item.flatIndex}
                            data-severity={item.issue.status}
                            className={`validation-pill-item ${isActive ? 'is-active' : ''}`}
                            onClick={() => selectIssue(item.issue.id)}
                            onMouseEnter={() => setActiveIndex(item.flatIndex)}
                          >
                            <span className="validation-pill-item-dot" aria-hidden="true" />
                            <span className="validation-pill-item-severity">{severityLabel}</span>
                            <span className="validation-pill-item-label">{item.label}</span>
                            <span className="validation-pill-item-go" aria-hidden="true"><ArrowRight width={11} height={11} strokeWidth={2.6} /></span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                  {shownIssues.length === 0 && (
                    <p className="validation-pill-empty">Aucun élément dans ce filtre.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
