import { filterValueCounts } from '../../../store/catalogue/filterValueCounts.js';
import { cardTagIds } from '../../../store/catalogue/entryModel.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus } from '../../icons/LucideLocal.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { tagCollision } from '../../../store/catalogue/tagSuggest.js';
import { navigateMenu } from '../../layout/menuNavigation.js';

const LABEL_LIMIT = 100;

/**
 * Entrées du sous-menu d'étiquettes, sans cadre : elles se posent dans un
 * `MenuSubmenu` (cascade du menu Filtres ou du menu contextuel) ou dans le
 * cadre `TagSubmenu` ci-dessous.
 * - Étiquetage immédiat (`targets`) : « Nouvelle étiquette… » en tête (saisie
 *   courte en place, Entrée crée et coche, Échap annule), puis les étiquettes à
 *   cocher (plein, partiel).
 * - Filtre (`onFilterChange`) : les étiquettes avec leur compteur (toujours
 *   « au moins une »).
 */
export function TagMenuEntries({ tags, cards = [], targets = [], busy, onMutate, filterValue, onFilterChange }) {
  const { t } = useCatalogueTranslation();
  const filtering = !!onFilterChange;
  const counts = useMemo(() => filtering ? filterValueCounts(cards, {}, { family: 'tags', values: tags }) : {}, [filtering, cards, tags]);
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const input = useRef(null);
  const newEntry = useRef(null);
  const refocus = useRef(false);
  const pending = useRef(false);
  const unavailable = busy || (!filtering && !targets.length);
  useEffect(() => {
    if (creating) input.current?.focus();
    else if (refocus.current) { refocus.current = false; newEntry.current?.focus(); }
  }, [creating]);
  const checked = tag => {
    if (filtering) return filterValue.ids.includes(tag.id);
    const owned = targets.filter(card => cardTagIds(card).includes(tag.id)).length;
    return owned === 0 ? false : owned === targets.length ? true : 'mixed';
  };
  function toggle(tag) {
    if (filtering) { onFilterChange({ ids: checked(tag) ? filterValue.ids.filter(id => id !== tag.id) : [...filterValue.ids, tag.id], mode: 'any' }); return Promise.resolve(); }
    return run({ addLabels: [], addTagIds: checked(tag) !== true ? [tag.id] : [], removeTagIds: checked(tag) === true ? [tag.id] : [] });
  }
  async function run(change) {
    if (unavailable || pending.current) return null;
    pending.current = true;
    try { return await onMutate({ kind: 'changeTags', ficheIds: targets.map(card => card.id), ...change }); } finally { pending.current = false; }
  }
  const stop = () => { setCreating(false); setLabel(''); refocus.current = true; };
  async function submit() {
    const text = label.trim().replace(/\s+/gu, ' ');
    if (!text) return;
    // Un libellé déjà connu (casse et accents ignorés) réutilise l'étiquette existante.
    const known = tagCollision(tags, text);
    if (known && checked(known) === true) { stop(); return; }
    const outcome = await run({ addLabels: known ? [] : [text], addTagIds: known ? [known.id] : [], removeTagIds: [] });
    if (outcome) stop();
  }
  return <>
    {!filtering && <>
      {creating
        ? <div className="catalogue-menu-input"><Plus width={16} height={16} aria-hidden="true" />
          <input ref={input} data-menu-input="true" value={label} maxLength={LABEL_LIMIT} aria-label={t('catalogue:tags.name')} placeholder={t('catalogue:tags.new')}
            onChange={event => setLabel(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void submit(); }
              else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stop(); }
            }} />
        </div>
        : <button type="button" ref={newEntry} role="menuitem" className="project-menu-item" aria-disabled={unavailable || undefined} onClick={() => { if (!unavailable) setCreating(true); }}>
          <Plus width={16} height={16} aria-hidden="true" /><span>{t('catalogue:tags.new')}</span>
        </button>}
      {tags.length > 0 && <div className="project-menu-sep" role="separator" />}
    </>}
    {tags.map(tag => <button type="button" key={tag.id} role="menuitemcheckbox" aria-checked={checked(tag)} aria-disabled={unavailable || undefined}
      className="project-menu-item" onClick={() => { void toggle(tag); }}>
      <span aria-hidden="true" className="catalogue-tag-check">{checked(tag) === true ? <Check width={14} height={14} /> : checked(tag) === 'mixed' ? '–' : ''}</span>
      <span>{tag.label}</span>
      {filtering ? <span className="catalogue-menu-count">{counts[tag.id]}</span> : checked(tag) === true && <span className="catalogue-menu-count">{t('catalogue:tags.alreadyAdded')}</span>}
    </button>)}
  </>;
}

/**
 * Cadre des étiquettes quand le déclencheur n'est pas un menu (barre de
 * sélection, bouton de la fiche, pastille de filtre) : le même sous-menu, posé
 * à côté du bouton, sans cascade possible.
 */
export function TagSubmenu({ onClose, position, trigger, placement, ...entries }) {
  const { t } = useCatalogueTranslation();
  const [placed, setPlaced] = useState(position);
  const panel = useRef(null);
  useEffect(() => {
    panel.current?.querySelector('[role^="menuitem"]')?.focus();
    const outside = event => { if (!event.target.closest?.('[data-catalogue-menu]')) onClose(); };
    document.addEventListener('pointerdown', outside, true);
    return () => { document.removeEventListener('pointerdown', outside, true); if (trigger?.isConnected) trigger.focus(); };
  // Capture the opening anchor and close callback for this menu instance.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const rect = panel.current?.getBoundingClientRect();
    if (rect) setPlaced({ x: Math.max(8, Math.min(position.x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(placement === 'above' ? position.y - rect.height : position.y, window.innerHeight - rect.height - 8)) });
  }, [entries.tags.length, position, placement]);
  return <div ref={panel} className="project-submenu catalogue-tag-popup" data-catalogue-menu="true" role="menu" aria-label={t('catalogue:tags.title')}
    style={{ left: placed.x, top: placed.y, ...(placement === 'above' ? { maxHeight: Math.max(0, position.y - 8) } : {}) }} onKeyDown={event => {
      if (event.key === 'Tab' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
      event.stopPropagation();
      navigateMenu(event, panel.current);
    }}>
    <TagMenuEntries {...entries} />
  </div>;
}
