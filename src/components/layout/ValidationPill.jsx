import { useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert, CircleCheck, Loader2 } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import './ValidationPill.css';

const ChevronDown = ({ size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path d="M1 3l4 4 4-4z" />
  </svg>
);

const ArrowRight = ({ size = 11 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 6h7M6 3l3 3-3 3" />
  </svg>
);

function parseIssue(issue) {
  const text = issue?.text ?? '';
  const dashIdx = text.indexOf(' — ');
  if (dashIdx === -1) {
    return { groupKey: '__pack__', groupLabel: 'Pack', label: text };
  }
  const location = text.slice(0, dashIdx);
  // L'en-tête de groupe porte déjà le chemin complet du nœud : les items ne
  // gardent que le champ à corriger, sans re-préfixer le nom.
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
    const groupKey = parsed.groupKey;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = { key: groupKey, label: parsed.groupLabel, items: [] };
      groupMap.set(groupKey, group);
    }
    group.items.push({ issue, label: parsed.label });
  });
  const groups = [...groupMap.values()];
  // Re-index flat positions so keyboard nav follows visual order.
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
  validationIssues = [],
  pathAuditPending = false,
  open,
  onOpenChange,
  onSelectIssue,
  onCountZeroTransition,
  shortcutLabel = '',
}) {
  const blockingIssues = useMemo(
    () => validationIssues.filter((i) => i?.status === 'error' || i?.status === 'warning'),
    [validationIssues],
  );
  const totalCount = blockingIssues.length;

  const { groups, flat } = useMemo(() => buildGroups(blockingIssues), [blockingIssues]);

  const state = pathAuditPending
    ? 'verifying'
    : totalCount > 0
      ? 'issues'
        : 'ok';
  const isOpen = open && state === 'issues';

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
    if (prevTotalCountRef.current > 0 && totalCount === 0) {
      onCountZeroTransition?.();
      if (open) onOpenChange?.(false);
    }
    prevTotalCountRef.current = totalCount;
  }, [totalCount, open, onOpenChange, onCountZeroTransition]);

  useEffect(() => {
    if (!isOpen) return undefined;
    function onPointerDown(e) {
      if (!wrapRef.current?.contains(e.target)) onOpenChange?.(false);
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onOpenChange?.(false);
        return;
      }
      if (!wrapRef.current?.contains(e.target)) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((idx) => (flat.length === 0 ? 0 : (idx + 1) % flat.length));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((idx) => (flat.length === 0 ? 0 : (idx - 1 + flat.length) % flat.length));
        return;
      }
      if (e.key === 'Enter') {
        const item = flat[activeIndex];
        if (item) {
          e.preventDefault();
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
  }, [isOpen, flat, activeIndex, onOpenChange, onSelectIssue]);

  useEffect(() => {
    if (!isOpen || !dropdownRef.current) return;
    const el = dropdownRef.current.querySelector(`[data-flat-idx="${activeIndex}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [isOpen, activeIndex]);

  const tooltipText = (() => {
    if (state === 'ok') return `Pack prêt${shortcutLabel ? ` (${shortcutLabel})` : ''}`;
    if (state === 'verifying') return 'Vérification des fichiers en cours…';
    const shortcutSuffix = shortcutLabel ? ` (${shortcutLabel})` : '';
    return `${totalCount} élément${totalCount > 1 ? 's' : ''} à corriger avant génération${shortcutSuffix}`;
  })();

  function selectIssue(issueId) {
    if (!issueId) return;
    onSelectIssue?.(issueId);
    onOpenChange?.(false);
  }

  function handlePillClick() {
    if (state !== 'issues') return;
    onOpenChange?.(!open);
  }

  function openPopover() {
    if (state !== 'issues') return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    onOpenChange?.(true);
  }

  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onOpenChange?.(false), 140);
  }

  function handleItemClick(item) {
    selectIssue(item.issue.id);
  }

  const popoverSubtitle = (() => {
    return `${totalCount} élément${totalCount > 1 ? 's' : ''} à corriger avant de générer le pack.`;
  })();

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
          className={`validation-pill is-${state} ${isOpen ? 'is-active' : ''}`}
          onClick={handlePillClick}
          aria-haspopup={state === 'issues' ? 'listbox' : undefined}
          aria-expanded={state === 'issues' ? isOpen : undefined}
          aria-label={tooltipText}
        >
          {state === 'issues' ? (
            <>
              <span className="validation-pill-icon"><TriangleAlert width={12} height={12} /></span>
              <span className="validation-pill-count">{totalCount}</span>
              <span className="validation-pill-label">à corriger</span>
              <span className="validation-pill-caret"><ChevronDown size={9} /></span>
            </>
          ) : state === 'ok' ? (
            <>
              <span className="validation-pill-check"><CircleCheck width={12} height={12} /></span>
              <span className="validation-pill-label">Pack prêt</span>
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
            className={`validation-pill-dd is-${state}`}
            ref={dropdownRef}
            role="listbox"
            aria-label="Liste des éléments à corriger"
          >
            <div className="validation-pill-dd-head">
              <span className="validation-pill-dd-title">À corriger</span>
              <span className="validation-pill-dd-subtitle">{popoverSubtitle}</span>
            </div>
            <div className="validation-pill-dd-body">
              {groups.map((group) => (
                <div key={group.key} className="validation-pill-group">
                  <div className="validation-pill-group-head">
                    <span className="validation-pill-group-label">{group.label}</span>
                    <span className="validation-pill-group-count">· {group.items.length}</span>
                  </div>
                  {group.items.map((item) => {
                      const isActive = item.flatIndex === activeIndex;
                      return (
                        <button
                          type="button"
                          key={`${item.issue.id ?? 'noid'}:${item.flatIndex}`}
                          data-flat-idx={item.flatIndex}
                          className={`validation-pill-item ${isActive ? 'is-active' : ''}`}
                          onClick={() => handleItemClick(item)}
                          onMouseEnter={() => setActiveIndex(item.flatIndex)}
                          role="option"
                          aria-selected={isActive}
                        >
                          <span className="validation-pill-item-dot" aria-hidden="true" />
                          <span className="validation-pill-item-label">{item.label}</span>
                          <span className="validation-pill-item-go" aria-hidden="true"><ArrowRight size={11} /></span>
                        </button>
                      );
                    })}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
