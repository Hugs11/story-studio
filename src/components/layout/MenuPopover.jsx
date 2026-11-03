import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './ProjectMenuPopover.css';

const NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];

// Socle des menus déroulants de barre d'outils (« Projet ▾ », « Catalogue ▾ ») :
// ouverture au survol, au focus ou au clic, pont de survol, fermeture par Échap
// ou clic extérieur, flèches entre les entrées. Les entrées appartiennent à
// l'appelant.
export function MenuPopover({ open, onOpenChange, trigger, title, description, label, children, placementBoundary, activation = 'hover' }) {
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = wrapRef.current?.getBoundingClientRect();
      const menu = menuRef.current?.getBoundingClientRect();
      const panel = wrapRef.current?.closest(placementBoundary ?? '.project-menu-wrap')?.getBoundingClientRect();
      const right = Math.min(window.innerWidth, placementBoundary ? panel?.right ?? window.innerWidth : window.innerWidth) - 8;
      if (anchor && menu) setOffset(Math.max(8 - anchor.left, Math.min(0, right - anchor.left - menu.width)));
    };
    position();
    window.addEventListener('resize', position);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    const container = placementBoundary ? wrapRef.current?.closest(placementBoundary) : wrapRef.current;
    if (container) observer?.observe(container);
    return () => { window.removeEventListener('resize', position); observer?.disconnect(); };
  }, [open, placementBoundary]);
  useEffect(() => {
    if (open && activation === 'click') menuRef.current?.querySelector('button:not(:disabled)')?.focus();
  }, [open, title, activation]);
  const closeTimerRef = useRef(null);
  const ignoreFocusRef = useRef(false);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open) return undefined;

    function onPointerDown(event) {
      if (!wrapRef.current?.contains(event.target)) onOpenChange?.(false);
    }

    function onKeyDown(event) {
      if (event.key !== 'Escape') return;
      // Fermer depuis une entrée rend le focus au bouton, sans le rouvrir.
      if (event.target?.closest?.('[role="menu"]') && wrapRef.current?.contains(event.target)) {
        event.preventDefault();
        ignoreFocusRef.current = true;
        wrapRef.current.querySelector('button')?.focus();
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
  }, [open, onOpenChange]);

  function openPopover() {
    if (ignoreFocusRef.current) return;
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    onOpenChange?.(true);
  }

  function scheduleClose() {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => onOpenChange?.(false), 140);
  }

  function handleKeyDown(event) {
    if (!open || !NAVIGATION_KEYS.includes(event.key)) return;
    // Les entrées d'un sous-menu en cascade ouvert (MenuSubmenu) ne comptent pas : il a sa propre navigation.
    const items = [...(wrapRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled), [role="menu"] button:not(:disabled)') ?? [])]
      .filter(item => !menuRef.current || (item.closest?.('[role="menu"]') ?? menuRef.current) === menuRef.current);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : index < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1)
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  return (
    <div
      className={`project-menu-wrap ${open ? 'is-open' : ''}`}
      ref={wrapRef}
      onPointerEnter={activation === 'hover' ? openPopover : undefined}
      onPointerLeave={activation === 'hover' ? scheduleClose : undefined}
      onMouseEnter={activation === 'hover' ? openPopover : undefined}
      onMouseLeave={activation === 'hover' ? scheduleClose : undefined}
      onFocus={activation === 'hover' ? openPopover : undefined}
      onKeyDown={handleKeyDown}
    >
      {trigger({ openPopover })}

      {open ? (
        <>
          <div className="project-menu-bridge" aria-hidden="true" />
          <div ref={menuRef} style={{ left: offset, '--project-menu-notch-left': `${22 - offset}px` }} className="project-menu" role="menu" aria-label={label}>
            {title || description ? <div className="project-menu-head">
              {title ? <strong>{title}</strong> : null}
              {description ? <span>{description}</span> : null}
            </div> : null}
            {children}
          </div>
        </>
      ) : null}
    </div>
  );
}

// Une entrée : icône, libellé et, s'il y a lieu, une seconde ligne (raccourci
// ou raison d'indisponibilité), toujours peinte pour garder la hauteur des entrées.
export function MenuItem({ toolbarId, Icon, label, detail = null, disabled = false, title, onClick }) {
  return (
    <button
      type="button"
      data-toolbar-id={toolbarId}
      className="project-menu-item"
      role="menuitem"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
    >
      <Icon className="chrome-icon" aria-hidden="true" strokeWidth={2} absoluteStrokeWidth />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
    </button>
  );
}
