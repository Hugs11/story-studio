import { useEffect, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { useEscapeKey } from '../../hooks/useEscapeKey.js';
import { LIST_COLUMNS } from '../../store/catalogue/listColumns.js';
import { Button } from '../common/Button.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { Columns3, GripVertical } from '../icons/LucideLocal.jsx';
import '../common/ColumnControls.css';

export function ColumnPicker({ columns }) {
  const { t } = useCatalogueTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({});
  const root = useRef(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useEscapeKey(open, close);
  useEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    if (rect) {
      const left = Math.max(8, Math.min(rect.right - panel.current.offsetWidth, window.innerWidth - panel.current.offsetWidth - 8));
      // 12 px sous le bouton comme `.project-menu`, encoche vers le centre du bouton.
      setPosition({ left, top: Math.max(8, Math.min(rect.bottom + 12, window.innerHeight - (panel.current?.offsetHeight ?? 420) - 8)), '--project-menu-notch-left': `${Math.max(12, Math.min(rect.left + rect.width / 2 - left - 6, panel.current.offsetWidth - 24))}px` });
    }
    panel.current?.querySelector('input:not(:disabled)')?.focus();
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="me-col-picker-wrap" ref={root}>
    <Tooltip text={t('catalogue:toolbar.columns.label')}>
      <Button ref={trigger} className={`me-col-picker-btn${open ? ' is-active' : ''}`} aria-label={t('catalogue:toolbar.columns.label')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? 'catalogue-column-picker' : undefined} onClick={() => open ? close() : setOpen(true)}>
        <Columns3 className="me-col-picker-icon" />
      </Button>
    </Tooltip>
    {open && <div id="catalogue-column-picker" ref={panel} className="me-col-picker-panel catalogue-column-picker" style={position} role="dialog" aria-label={t('catalogue:toolbar.columns.label')}>
      <div className="catalogue-column-scroll">
        <div className="catalogue-column-heading catalogue-section-title" aria-hidden="true">{t('catalogue:toolbar.columns.title')}</div>
        <CatalogueColumnChoices columns={columns} />
      </div>
    </div>}
  </div>;
}

export function CatalogueColumnChoices({ columns }) {
  const { t } = useCatalogueTranslation();
  return <>
      {LIST_COLUMNS.map(column => <label key={column.id} className="me-col-picker-row">
        <GripVertical width={14} height={14} aria-hidden="true" /><input type="checkbox" checked={columns.visibleCols.has(column.id)} disabled={column.id === 'title'} onChange={() => columns.toggleCol(column.id)} />
        <span>{column.id === 'title' ? t('catalogue:toolbar.columns.alwaysTitle') : t(column.labelKey)}</span>
      </label>)}
      <Button variant="ghost" size="sm" onClick={columns.resetColumns}>{t('catalogue:toolbar.columns.reset')}</Button>
  </>;
}

