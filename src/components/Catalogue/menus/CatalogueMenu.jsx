import { Tooltip } from '../../common/Tooltip.jsx';
import { ChevronRight, Info } from '../../icons/LucideLocal.jsx';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { menuKeyAction } from '../../../store/catalogue/menuState.js';
import { domId } from '../../../store/catalogue/viewModes.js';

/**
 * Élément de menu : désactivé, il reste atteignable au clavier et affiche sa
 * raison (texte visible, liée par `aria-describedby`). `cascade` : propriétés
 * d'ouverture d'un sous-menu en cascade (MenuSubmenu) ; `Icon` précède le libellé.
 */
export function CatalogueMenuItem({ entry, index, active, onActivate, onHover, itemRef, onCopied, Icon, cascade }) {
  const { t, line } = useCatalogueTranslation();
  const { action } = entry;
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearTimeout(timer.current); };
  }, []);
  const activate = async () => {
    if (!action.enabled || copied) return;
    const success = await onActivate(entry);
    if (!mounted.current || !['copyUuid', 'copyTitle'].includes(action.id) || success !== true) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { setCopied(false); onCopied?.(); }, 1000);
  };
  const id = domId('catalogue-menu-item', `${index}-${entry.key}`);
  const reasonId = `${id}-reason`;
  const hintId = `${id}-hint`;
  const described = [action.enabled ? null : reasonId, action.hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return <div
    role="menuitem"
    id={id}
    ref={element => { itemRef?.(element); cascade?.ref(element); }}
    tabIndex={active ? 0 : -1}
    className={`catalogue-menu-item${Icon ? ' has-icon' : ''}`}
    aria-haspopup={cascade?.['aria-haspopup']}
    aria-expanded={cascade?.['aria-expanded']}
    onKeyDown={cascade?.onKeyDown}
    aria-disabled={action.enabled ? undefined : 'true'}
    aria-describedby={described}
    onClick={(event) => { if (cascade) { cascade.onClick(event); return; } event.stopPropagation(); void activate(); }}
    onPointerMove={() => onHover(index)}
  >
    <span className="catalogue-menu-item-head">
      {Icon && <Icon className="catalogue-menu-item-icon" width={16} height={16} aria-hidden="true" />}
      <span className="catalogue-menu-item-label" aria-live="polite">{copied ? t('catalogue:fiche.uuid.copied') : entry.label ?? t(action.labelKey)}</span>
      {!action.enabled && action.reasonKey && <Tooltip text={t(action.reasonKey, action.reasonParams)} asChild wrap><span id={reasonId} aria-label={t(action.reasonKey, action.reasonParams)} className="catalogue-menu-item-reason-mark"><Info width={14} height={14} aria-hidden="true" /></span></Tooltip>}
      {entry.submenu && <ChevronRight width={14} height={14} aria-hidden="true" />}
    </span>
    {entry.detail && <span className="catalogue-menu-item-detail">{entry.detail}</span>}
    {action.hint && <span id={hintId} className="catalogue-menu-item-detail">{line(action.hint)}</span>}
  </div>;
}

/**
 * Panneau de menu commun : rôle `menu`, navigation par flèches, Début/Fin,
 * Échap (ferme et rend le focus au déclencheur), Tab (ferme), Entrée/Espace
 * (active). Le contenu (groupes et éléments) est fourni par `children`, qui
 * reçoit les propriétés de chaque élément par index.
 */
export function CatalogueMenuPanel({ menu, label, dispatch, onActivate, onBack, children }) {
  const items = useRef([]);
  const panel = useRef(null);
  const [position, setPosition] = useState(menu.position);
  useEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (!rect || !menu.position) return;
    setPosition({ x: Math.max(8, Math.min(menu.position.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(menu.position.y, window.innerHeight - rect.height - 8)) });
  }, [menu.position, menu.step]);
  useEffect(() => {
    if (menu.open) items.current[menu.activeIndex]?.focus();
  }, [menu.open, menu.activeIndex, menu.step]);
  const style = position ? { left: `${position.x}px`, top: `${position.y}px` } : undefined;
  const itemProps = (index) => ({
    index,
    active: index === menu.activeIndex,
    itemRef: (element) => { items.current[index] = element; },
    onActivate,
    onCopied: () => dispatch({ type: 'close' }),
    onHover: (target) => dispatch({ type: 'focus', index: target }),
  });
  return <div
    className="catalogue-menu"
    data-catalogue-menu="true"
    ref={panel}
    role="menu"
    aria-label={label}
    style={style}
    onKeyDown={(event) => {
      const action = menuKeyAction(menu, event.key);
      if (!action) return;
      event.stopPropagation();
      if (action.type !== 'close' || action.restoreFocus !== false) event.preventDefault();
      if (action.type === 'activate') items.current[menu.activeIndex]?.click();
      else if (action.type === 'back') onBack();
      else dispatch(action);
    }}
  >{children(itemProps)}</div>;
}

/** Les menus passent au-dessus de la fiche complète, elle-même superposée. */
export function CatalogueMenuLayer({ children }) {
  return createPortal(<div className="catalogue-menu-layer">{children}</div>, document.body);
}
