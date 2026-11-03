import { observeResizeDeferred } from '../../../hooks/observeResizeDeferred.js';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useEscapeKey } from '../../../hooks/useEscapeKey.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { Tag } from '../../icons/LucideLocal.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { CatalogueMenuLayer } from '../menus/CatalogueMenu.jsx';
import './CardTagIndicator.css';

/** Keep complete labels visible; reserve a menu only for actual overflow. */
export function fittingTagCount(widths, available, overflowWidth, gap = 4) {
  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gap;
  if (total <= available) return widths.length;
  let used = 0;
  let count = 0;
  for (const width of widths) {
    if (used + width + (count + 1) * gap + overflowWidth > available) break;
    used += width;
    count++;
  }
  return count;
}
export function CardTagIndicator({ tags = [], onFilter, tabIndex = 0 }) {
  const { t } = useCatalogueTranslation();
  const menuId = useId();
  const root = useRef(null);
  const measure = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const initialIndex = useRef(0);
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(tags.length);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const hiddenTags = tags.slice(visibleCount);
  const expanded = open && hiddenTags.length > 0;
  useLayoutEffect(() => {
    if (!root.current || !measure.current) return;
    const update = () => {
      const widths = [...measure.current.querySelectorAll('[data-tag-width]')].map(element => element.getBoundingClientRect().width);
      const overflow = measure.current.querySelector('[data-overflow-width]')?.getBoundingClientRect().width ?? 0;
      const gap = parseFloat(getComputedStyle(root.current).columnGap) || 0;
      const count = fittingTagCount(widths, root.current.clientWidth, overflow, gap);
      setVisibleCount(count);
    };
    update();
    return observeResizeDeferred([root.current, measure.current], update);
  }, [tags]);
  const close = (restore = true) => {
    setOpen(false);
    if (restore) requestAnimationFrame(() => { if (trigger.current?.isConnected) trigger.current.focus(); });
  };
  useEscapeKey(expanded, () => close());
  useEffect(() => { setOpen(false); }, [visibleCount, tags]);
  useLayoutEffect(() => {
    if (!expanded) return;
    const anchor = trigger.current?.getBoundingClientRect();
    const menu = panel.current?.getBoundingClientRect();
    if (!anchor || !menu) return;
    const below = anchor.bottom + 6;
    setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8)), top: Math.max(8, Math.min(below + menu.height <= window.innerHeight - 8 ? below : anchor.top - menu.height - 6, window.innerHeight - menu.height - 8)) });
    const buttons = panel.current.querySelectorAll('button');
    buttons[initialIndex.current < 0 ? buttons.length - 1 : 0]?.focus();
  }, [expanded, tags]);
  useEffect(() => {
    if (!expanded) return undefined;
    const outside = event => { if (!panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close(false); };
    const scroll = event => { if (!panel.current?.contains(event.target)) close(false); };
    const resize = () => close(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize); };
  // Listeners own this menu instance; close only uses refs and the stable setter.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);
  if (!tags.length) return null;
  const label = t('catalogue:tags.card.show', { count: hiddenTags.length });
  return <div ref={root} className="catalogue-card-tag-indicator">
    <div className="catalogue-card-tag-measure-clip" aria-hidden="true"><div ref={measure} className="catalogue-card-tag-measure">
      {tags.map(tag => <span key={tag.id} data-tag-width className="catalogue-filter-badge">{tag.label}</span>)}
      <span data-overflow-width className="catalogue-filter-badge catalogue-card-tag-overflow"><Tag width={14} height={14} /><span>{tags.length}</span></span>
    </div></div>
    {tags.slice(0, visibleCount).map(tag => <Tooltip key={tag.id} text={tag.label} asChild whenTruncated><button type="button" className="catalogue-filter-badge catalogue-card-tag catalogue-card-tag-indicator--single" aria-label={tag.label} tabIndex={tabIndex}
      onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => { if (['Enter', ' '].includes(event.key)) event.stopPropagation(); }}
      onClick={event => { event.stopPropagation(); if (event.detail > 1) return; onFilter(tag.id); }}>{tag.label}</button></Tooltip>)}
    {hiddenTags.length > 0 && <Tooltip text={hiddenTags.map(tag => tag.label).join(' · ')} asChild wrap disabled={expanded}>
      <button ref={trigger} type="button" className="catalogue-filter-badge catalogue-card-tag-overflow" tabIndex={tabIndex}
        aria-label={label} aria-haspopup="menu" aria-expanded={expanded} aria-controls={expanded ? menuId : undefined}
        onDoubleClick={event => event.stopPropagation()}
        onKeyDown={event => {
          if (['Enter', ' '].includes(event.key)) event.stopPropagation();
          if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); initialIndex.current = event.key === 'ArrowUp' ? -1 : 0; setOpen(true); }
        }}
        onClick={event => {
          event.stopPropagation();
          if (event.detail > 1) return;
          initialIndex.current = 0; setOpen(value => !value);
        }}><Tag width={14} height={14} /><span>{hiddenTags.length}</span></button>
    </Tooltip>}
    {expanded && <CatalogueMenuLayer><div id={menuId} ref={panel} className="catalogue-menu catalogue-card-tags-menu" role="menu" aria-label={t('catalogue:tags.title')} style={position}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...panel.current.querySelectorAll('button')];
          const index = buttons.indexOf(document.activeElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        } else if (event.key === 'Tab') { event.preventDefault(); close(); }
      }}>
      {hiddenTags.map(tag => <button type="button" className="catalogue-menu-item" role="menuitem" key={tag.id} onClick={() => { close(); onFilter(tag.id); }}>{tag.label}</button>)}
    </div></CatalogueMenuLayer>}
  </div>;
}
