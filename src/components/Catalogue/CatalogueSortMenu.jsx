import { useEffect, useRef, useState } from 'react';
import { MenuPopover } from '../layout/MenuPopover.jsx';
import { ListFilter, ChevronDown } from '../icons/LucideLocal.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';

// Choix de la clé de tri : menu de l'app (socle MenuPopover), jamais la liste
// déroulante du système. Choix exclusif (`menuitemradio`), coche sur la clé
// courante ; flèches, Début/Fin et Échap viennent du socle, qui rend le focus
// au bouton.
export function CatalogueSortMenu({ items, value, onChange, label, prefix, onOpen, id = 'catalogue-sort' }) {
  const { t } = useCatalogueTranslation();
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  useEffect(() => {
    // À l'ouverture, le focus va sur l'option courante (le socle visait la première).
    if (open) trigger.current?.closest('.project-menu-wrap')?.querySelector('[aria-checked="true"]')?.focus();
  }, [open]);
  const choose = key => {
    setOpen(false);
    if (key !== value) onChange(key);
    trigger.current?.focus();
  };
  const current = items.find(item => item.key === value);
  const description = t('catalogue:toolbar.sort.current', { criterion: current?.label });
  return <Tooltip text={description} disabled={open}><MenuPopover activation="click" open={open} onOpenChange={setOpen} label={label}
    trigger={() => <button aria-label={description} ref={trigger} type="button" id={id} className="catalogue-sort-field" aria-haspopup="menu" aria-expanded={open}
      onClick={() => { onOpen?.(); setOpen(!open); }}>
      <ListFilter className="catalogue-compact-icon" width={16} height={16} aria-hidden="true" />
      <span className="catalogue-sort-label">{prefix}</span>
      <span className="catalogue-sort-value">{current?.label}</span>
      <ChevronDown className="catalogue-sort-caret" width={14} height={14} aria-hidden="true" />
    </button>}>
    {items.map(item => <button type="button" key={item.key} role="menuitemradio" aria-checked={item.key === value} className="project-menu-item catalogue-sort-option" onClick={() => choose(item.key)}>{item.label}</button>)}
  </MenuPopover></Tooltip>;
}
