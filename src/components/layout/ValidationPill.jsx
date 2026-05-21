import { useEffect, useMemo, useRef, useState } from 'react';
import { TriangleAlert, CircleCheck, Loader2 } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import './ValidationPill.css';

const ChevronDown = ({ size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path d="M1 3l4 4 4-4z" />
  </svg>
);

const XIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <path d="M3 3l6 6M9 3l-6 6" />
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
  const error = text.slice(dashIdx + 3);
  const parts = location.split(' / ');
  const nodeName = parts[parts.length - 1] || location;
  return {
    groupKey: location,
    groupLabel: location,
    label: parts.length > 1 ? `${nodeName} — ${error}` : error,
  };
}

function buildGroups(issues) {
  const groupMap = new Map();
  const flat = [];
  issues.forEach((issue) => {
    const parsed = parseIssue(issue);
    let group = groupMap.get(parsed.groupKey);
    if (!group) {
      group = { key: parsed.groupKey, label: parsed.groupLabel, items: [] };
      groupMap.set(parsed.groupKey, group);
    }
    const item = { issue, label: parsed.label, flatIndex: flat.length };
    group.items.push(item);
    flat.push(item);
  });
  return { groups: [...groupMap.values()], flat };
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
  const errors = useMemo(
    () => validationIssues.filter((i) => i?.status === 'error'),
    [validationIssues],
  );
  const errorCount = errors.length;

  const { groups, flat } = useMemo(() => buildGroups(errors), [errors]);

  const state = pathAuditPending ? 'verifying' : errorCount > 0 ? 'errors' : 'ok';
  const isOpen = open && state === 'errors';

  const wrapRef = useRef(null);
  const dropdownRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    if (!isOpen) setActiveIndex(0);
  }, [isOpen]);

  useEffect(() => {
    if (activeIndex > flat.length - 1) setActiveIndex(Math.max(0, flat.length - 1));
  }, [flat.length, activeIndex]);

  const prevErrorCountRef = useRef(errorCount);
  useEffect(() => {
    if (prevErrorCountRef.current > 0 && errorCount === 0) {
      onCountZeroTransition?.();
      if (open) onOpenChange?.(false);
    }
    prevErrorCountRef.current = errorCount;
  }, [errorCount, open, onOpenChange, onCountZeroTransition]);

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
          onSelectIssue?.(item.issue.id);
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

  const tooltipText = state === 'errors'
    ? `${errorCount} erreur${errorCount > 1 ? 's' : ''} à corriger${shortcutLabel ? ` (${shortcutLabel})` : ''}`
    : state === 'ok'
      ? `Tout est en ordre${shortcutLabel ? ` (${shortcutLabel})` : ''}`
      : 'Vérification des fichiers en cours…';

  function handlePillClick() {
    if (state !== 'errors') return;
    onOpenChange?.(!open);
  }

  function handleItemClick(item) {
    onSelectIssue?.(item.issue.id);
  }

  return (
    <div className={`validation-pill-wrap ${isOpen ? 'is-open' : ''}`} ref={wrapRef}>
      <Tooltip text={tooltipText}>
        <button
          type="button"
          className={`validation-pill is-${state} ${isOpen ? 'is-active' : ''}`}
          onClick={handlePillClick}
          aria-haspopup={state === 'errors' ? 'listbox' : undefined}
          aria-expanded={state === 'errors' ? isOpen : undefined}
          aria-label={tooltipText}
        >
          {state === 'errors' ? (
            <>
              <span className="validation-pill-icon"><TriangleAlert width={12} height={12} /></span>
              <span className="validation-pill-count">{errorCount}</span>
              <span className="validation-pill-label">Validation</span>
              <span className="validation-pill-caret"><ChevronDown size={9} /></span>
            </>
          ) : state === 'ok' ? (
            <>
              <span className="validation-pill-check"><CircleCheck width={12} height={12} /></span>
              <span className="validation-pill-label">Tout est en ordre</span>
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
        <div
          className="validation-pill-dd"
          ref={dropdownRef}
          role="listbox"
          aria-label="Liste des erreurs de validation"
        >
          <div className="validation-pill-dd-head">
            <span className="validation-pill-dd-icon"><TriangleAlert width={13} height={13} /></span>
            <span className="validation-pill-dd-title">
              VALIDATION
              <em>· {errorCount} élément{errorCount > 1 ? 's' : ''} à corriger</em>
            </span>
            <button
              type="button"
              className="validation-pill-dd-close"
              onClick={() => onOpenChange?.(false)}
              aria-label="Fermer"
            >
              <XIcon size={12} />
            </button>
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
      ) : null}
    </div>
  );
}
