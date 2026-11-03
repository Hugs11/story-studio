import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { insideIntentTriangle, submenuPlacement } from './submenuGeometry.js';
import { menuItems, navigateMenu } from './menuNavigation.js';
import './ProjectMenuPopover.css';

const OPEN_DELAY = 160;
const CLOSE_DELAY = 320;
const OPENED = 'project-submenu-open';

// Sous-menu en cascade, commun à tous les menus de l'app (menu Filtres, menu
// contextuel des fiches). `trigger(props)` rend l'entrée parente et doit poser
// `props.ref`, `aria-haspopup`, `aria-expanded`, `onClick` et `onKeyDown` sur
// l'élément qui porte le rôle `menuitem`. Le sous-menu s'ouvre à côté du menu
// parent, qui reste visible :
// - au survol, après une courte temporisation ; à la sortie du pointeur, la
//   fermeture attend et reste suspendue tant que le pointeur avance vers le
//   sous-menu (triangle de tolérance) ;
// - au clic, ou au clavier avec → / Entrée / Espace (focus sur la 1re entrée) ;
// - ← ou Échap le referment et rendent le focus à l'entrée parente (Échap au
//   niveau racine ferme tout) ;
// - un seul sous-menu frère ouvert à la fois ; hauteur bornée à la fenêtre,
//   défilement interne.
export function MenuSubmenu({ trigger, label, children, onOpenChange }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);
  const openTimer = useRef(null);
  const closeTimer = useRef(null);
  const origin = useRef(null);
  const focusFirst = useRef(false);
  const flipped = useRef(false);
  const stopTracking = useRef(null);

  const clearTimers = () => {
    clearTimeout(openTimer.current); clearTimeout(closeTimer.current);
    openTimer.current = null; closeTimer.current = null;
    stopTracking.current?.(); stopTracking.current = null;
  };
  const change = value => { setOpen(value); onOpenChange?.(value); };
  const close = ({ restoreFocus = false } = {}) => {
    clearTimers();
    if (restoreFocus || menuRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
    change(false);
  };
  const openNow = ({ focus = false } = {}) => {
    clearTimeout(closeTimer.current);
    if (focus) focusFirst.current = true;
    if (!open) change(true);
    else if (focus) menuItems(menuRef.current)[0]?.focus();
  };

  useEffect(() => () => clearTimers(), []);

  useLayoutEffect(() => {
    if (!open) { setPlace(null); return undefined; }
    const position = () => {
      const menu = menuRef.current; const wrap = wrapRef.current;
      if (!menu || !wrap) return;
      const style = getComputedStyle(menu);
      const rect = menu.getBoundingClientRect();
      const next = submenuPlacement({
        parent: (wrap.closest('[role="menu"]') ?? wrap).getBoundingClientRect(),
        anchor: wrap.getBoundingClientRect(),
        size: { width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        inset: (parseFloat(style.paddingTop) || 0) + (parseFloat(style.borderTopWidth) || 0),
      });
      flipped.current = next.flipped;
      setPlace(current => current && current.left === next.left && current.top === next.top ? current : { left: next.left, top: next.top });
    };
    position();
    window.addEventListener('resize', position);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    if (menuRef.current) observer?.observe(menuRef.current);
    return () => { window.removeEventListener('resize', position); observer?.disconnect(); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    // Un seul sous-menu ouvert à la fois parmi les frères (pas les ancêtres).
    const onOther = event => {
      const other = event.detail;
      if (other !== wrapRef.current && !other.contains(wrapRef.current) && !wrapRef.current?.contains(other)) close();
    };
    document.addEventListener(OPENED, onOther);
    document.dispatchEvent(new CustomEvent(OPENED, { detail: wrapRef.current }));
    if (focusFirst.current) { focusFirst.current = false; menuItems(menuRef.current)[0]?.focus(); }
    return () => document.removeEventListener(OPENED, onOther);
  // `close` ne dépend que de refs et de `onOpenChange`.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function scheduleClose() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => close(), CLOSE_DELAY);
  }
  function onPointerEnter(event) {
    if (event.pointerType === 'touch') return;
    clearTimeout(closeTimer.current); stopTracking.current?.(); stopTracking.current = null;
    if (open || openTimer.current) return;
    openTimer.current = setTimeout(() => { openTimer.current = null; openNow(); }, OPEN_DELAY);
  }
  function onPointerLeave(event) {
    if (event.pointerType === 'touch') return;
    clearTimeout(openTimer.current); openTimer.current = null;
    if (!open) return;
    origin.current = { x: event.clientX, y: event.clientY };
    const follow = move => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (rect && insideIntentTriangle({ x: move.clientX, y: move.clientY }, origin.current, rect, flipped.current)) scheduleClose();
    };
    document.addEventListener('pointermove', follow);
    stopTracking.current = () => document.removeEventListener('pointermove', follow);
    scheduleClose();
  }

  const triggerProps = {
    ref: element => { triggerRef.current = element; },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: event => { event.stopPropagation?.(); openNow({ focus: event.detail === 0 }); },
    onKeyDown: event => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault(); event.stopPropagation();
      openNow({ focus: true });
    },
  };

  function onMenuKeyDown(event) {
    const inField = event.target?.tagName === 'INPUT';
    if (event.key === 'Escape' || (event.key === 'ArrowLeft' && !inField)) {
      event.preventDefault(); event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    // Tab remonte pour fermer le menu racine ; le reste appartient au sous-menu
    // (le menu parent ne doit ni naviguer ni activer sa propre entrée).
    if (event.key === 'Tab') return;
    event.stopPropagation();
    navigateMenu(event, menuRef.current);
  }

  return <div ref={wrapRef} className="project-submenu-wrap" onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
    {trigger(triggerProps)}
    {open ? <div ref={menuRef} role="menu" aria-label={label} className="project-submenu" onKeyDown={onMenuKeyDown}
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, opacity: 0, pointerEvents: 'none' }}>{children}</div> : null}
  </div>;
}
