import { useEffect, useRef } from 'react';
import { ArrowRight, TriangleAlert, CircleCheck, Loader2, X } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import './ValidationPill.css';

// Le caret du bouton est un **glyphe plein**, pas une icône : il joue le rôle
// typographique d'un « ▾ » à 9 px, taille à laquelle le chevron tracé du jeu
// partagé rendrait un trait d'un demi-pixel. Il reste donc ici, et l'inventaire
// des jeux d'icônes le nomme avec cette raison.
const Caret = ({ size = 10 }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
    <path d="M1 3l4 4 4-4z" />
  </svg>
);

// Socle commun des pastilles de barre d'outils (« à corriger » des éditeurs,
// activité du catalogue) : forme, compteur, caret, déploiement au survol et
// popover au même gabarit. Le contenu du popover appartient à l'appelant.
//
// `state` choisit la couleur : `issues` (ambre, un problème à régler), `ok`
// (succès), `info` (neutre), `progress` (neutre, travail en cours, ouvrable)
// et `verifying` (neutre, non ouvrable).
//
// `keepOpen` : pendant un travail suivi (un envoi vers la Lunii), ni la sortie
// du survol ni un clic ailleurs ne referment le popover ; la pastille ou Échap,
// oui.
export function StatusPill({
  state,
  open,
  onOpenChange,
  tooltip,
  label,
  count = null,
  toolbarId,
  popoverLabel,
  title,
  subtitle = null,
  headerAction = null,
  wrapRef: externalWrapRef = null,
  dropdownRef = null,
  dropdownClassName = '',
  restoreFocusOnEscape = false,
  keepOpen = false,
  children,
}) {
  const interactive = state !== 'verifying';
  const isOpen = open && interactive;
  const localWrapRef = useRef(null);
  const wrapRef = externalWrapRef ?? localWrapRef;
  const buttonRef = useRef(null);
  const closeTimerRef = useRef(null);
  const ignoreFocusRef = useRef(false);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    function onPointerDown(event) {
      if (!keepOpen && !wrapRef.current?.contains(event.target)) onOpenChange?.(false);
    }
    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      // Fermer depuis le popover rend le focus au bouton, sans le rouvrir.
      if (restoreFocusOnEscape && wrapRef.current?.contains(event.target) && event.target !== buttonRef.current) {
        ignoreFocusRef.current = true;
        buttonRef.current?.focus();
        ignoreFocusRef.current = false;
      }
      onOpenChange?.(false);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, keepOpen, onOpenChange, restoreFocusOnEscape, wrapRef]);

  function handlePillClick() {
    if (interactive) onOpenChange?.(!open);
  }

  function openPopover() {
    if (!interactive || ignoreFocusRef.current) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    onOpenChange?.(true);
  }

  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (keepOpen) return;
    closeTimerRef.current = setTimeout(() => onOpenChange?.(false), 140);
  }

  const spinner = state === 'verifying' || state === 'progress';

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
      <Tooltip text={tooltip} disabled={isOpen}>
        <button
          ref={buttonRef}
          type="button"
          data-toolbar-id={toolbarId}
          className={`validation-pill is-${state} ${isOpen ? 'is-active' : ''}`}
          onClick={handlePillClick}
          aria-haspopup={interactive ? 'dialog' : undefined}
          aria-expanded={interactive ? isOpen : undefined}
          aria-label={tooltip}
        >
          {spinner ? (
            <span className="validation-pill-spinner"><Loader2 width={12} height={12} /></span>
          ) : (
            <span className={state === 'issues' ? 'validation-pill-icon' : 'validation-pill-check'}>
              {state === 'issues'
                ? <TriangleAlert width={12} height={12} />
                : <CircleCheck width={12} height={12} />}
            </span>
          )}
          {count != null ? <span className="validation-pill-count">{count}</span> : null}
          <span className="validation-pill-label">{label}</span>
          {interactive ? <span className="validation-pill-caret"><Caret size={9} /></span> : null}
        </button>
      </Tooltip>

      {isOpen ? (
        <>
          <div className="validation-pill-hover-bridge" aria-hidden="true" />
          <div
            className={`validation-pill-dd is-${state}${dropdownClassName ? ` ${dropdownClassName}` : ''}`}
            ref={dropdownRef}
            role="dialog"
            aria-label={popoverLabel}
          >
            <div className={`validation-pill-dd-head${headerAction ? ' has-action' : ''}`}>
              <span className="validation-pill-dd-title">{title}</span>
              {subtitle != null ? <span className="validation-pill-dd-subtitle">{subtitle}</span> : null}
              {headerAction}
            </div>
            <div className="validation-pill-dd-body">
              {children}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

// Une entrée de la liste, au gabarit des corrections : point, libellé, flèche.
// Cliquable quand elle mène quelque part.
export function StatusPillItem({ label, active = false, onClick, onMouseEnter, ...props }) {
  return (
    <button
      type="button"
      {...props}
      className={`validation-pill-item ${active ? 'is-active' : ''}`}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      <span className="validation-pill-item-dot" aria-hidden="true" />
      <span className="validation-pill-item-label">{label}</span>
      <span className="validation-pill-item-go" aria-hidden="true"><ArrowRight width={11} height={11} strokeWidth={2.6} /></span>
    </button>
  );
}

// Une entrée avec, au besoin, une croix pour l'effacer et un détail (texte,
// actions) sous le libellé. `tone` colore le point : `issue` (à régler),
// `info`, `progress` ou `success`.
export function StatusPillEntry({ tone = 'issue', label, onSelect = null, onDismiss = null, dismissLabel, children = null }) {
  return (
    <div className={`validation-pill-entry is-${tone}${onDismiss ? ' has-dismiss' : ''}`}>
      {onSelect
        ? <StatusPillItem label={label} onClick={onSelect} />
        : (
          <div className="validation-pill-item is-static">
            <span className="validation-pill-item-dot" aria-hidden="true" />
            <span className="validation-pill-item-label">{label}</span>
          </div>
        )}
      {onDismiss ? (
        <Tooltip text={dismissLabel} asChild>
          <button type="button" className="validation-pill-item-dismiss" onClick={onDismiss} aria-label={dismissLabel}>
            <X width={12} height={12} strokeWidth={2.4} />
          </button>
        </Tooltip>
      ) : null}
      {children ? <div className="validation-pill-details-body">{children}</div> : null}
    </div>
  );
}
