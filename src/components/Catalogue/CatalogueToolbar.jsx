import './CatalogueToolbar.css';
import { useMemo, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { getCurrentShortcuts, getShortcutLabelMap, DEFAULT_SHORTCUTS } from '../../store/keyboardShortcuts.js';
import { commandKeyIsMeta } from '../../utils/platformKeys.js';
import { filterValueCounts } from '../../store/catalogue/filterValueCounts.js';
import { ageFilterLabel } from '../../store/catalogue/ageFilter.js';
import { tagPopoverAt } from '../../store/catalogue/tagPopover.js';
import { FILTER_MENU_TOGGLES, filterMenuValues } from '../../store/catalogue/filterState.js';
import { sourceFolderOptions } from '../../store/catalogue/sourceView.js';
import { SORT_KEYS } from '../../store/catalogue/sort.js';
import { SORT_LABELS } from '../../store/catalogue/viewModes.js';
import { CatalogueViewControls } from './CatalogueViewControls.jsx';
import { CatalogueSortMenu } from './CatalogueSortMenu.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { Button } from '../common/Button.jsx';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search, X, ChevronDown, ChevronRight, Star, SlidersHorizontal, FileX, ListFilter, Tag, Layers, Languages, CircleDashed, EyeOff, Folder } from '../icons/LucideLocal.jsx';
import { CatalogueFilterBar, ActiveFilterSummary } from './CatalogueFilterBar.jsx';
import { MenuPopover } from '../layout/MenuPopover.jsx';
import { MenuSubmenu } from '../layout/MenuSubmenu.jsx';
import { TagMenuEntries, TagSubmenu } from './tags/TagSubmenu.jsx';
import { CatalogueMenuLayer } from './menus/CatalogueMenu.jsx';

const FILTER_ICONS = { favoritesOnly: Star, incompleteOnly: CircleDashed, missingFilesOnly: FileX, hideOfficial: EyeOff, tags: Tag, formats: Layers, languages: Languages, sourceIds: Folder };

/** Met en police mono le nombre qui ouvre la phrase déjà traduite ; le reste de la phrase reste inchangé. */
function LeadingNumber({ number, text }) {
  const digits = String(number);
  return text.startsWith(digits) ? <><span className="catalogue-result-number">{digits}</span>{text.slice(digits.length)}</> : text;
}

export function CatalogueToolbar({ view, searchRef, renderChrome, cards = [], sources = [], tags = [], }) {
  const { t, line } = useCatalogueTranslation();
  const folderCount = useMemo(() => sourceFolderOptions(sources).length, [sources]);
  const counts = useMemo(() => filterValueCounts(cards, view), [cards, view.filters, view.query]);
  const shortcut = getCurrentShortcuts().catalogueSearch ?? DEFAULT_SHORTCUTS.catalogueSearch;
  const searchShortcut = getShortcutLabelMap(getCurrentShortcuts()).catalogueSearch;
  const ariaShortcut = [shortcut.ctrl && (commandKeyIsMeta() ? 'Meta' : 'Control'), shortcut.meta && 'Meta', shortcut.alt && 'Alt', shortcut.shift && 'Shift', shortcut.key === ' ' ? 'Space' : shortcut.key?.length === 1 ? shortcut.key.toUpperCase() : shortcut.key].filter(Boolean).join('+');
  const ageSummary = view.summary.find(item => item.family === 'age');
  const [ageOpen, setAgeOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const [chipMenu, setChipMenu] = useState(null);
  const [tagAnchor, setTagAnchor] = useState(null);
  const editTrigger = useRef(null);
  const closeEditor = () => { setMenu(null); setChipMenu(null); editTrigger.current?.focus?.(); };
  // Modifier un filtre depuis sa pastille ; dans le menu Filtres, les valeurs s'ouvrent en cascade.
  const edit = (family, trigger) => {
    editTrigger.current = trigger;
    setMenu(null);
    if (family === 'tags') { setChipMenu('tags'); setTagAnchor(tagPopoverAt(trigger, undefined, 'filter')); }
    else setChipMenu(family);
  };
  const sortLabels = SORT_KEYS.map(key => ({ key, label: t(SORT_LABELS[key]) }));
  const DirectionIcon = view.sort.direction === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  const searchControls = <div className="catalogue-toolbar" role="group" aria-label={t('catalogue:toolbar.label')}>
      <div className="catalogue-search-wrap">
        <div className="catalogue-search">
          <span className="catalogue-search-icon" aria-hidden="true"><Search width={18} height={18} /></span>
          <input id="catalogue-search" ref={searchRef} type="search" autoComplete="off" value={view.query}
            aria-keyshortcuts={ariaShortcut} aria-label={t('catalogue:toolbar.search.label')} placeholder={t('catalogue:toolbar.search.placeholder')}
            onFocus={() => { setMenu(null); setChipMenu(null); }}
            onChange={event => view.setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); view.setQuery(''); } }} />
          <kbd className="catalogue-search-shortcut" aria-hidden="true">{t('catalogue:toolbar.search.shortcut', { shortcut: searchShortcut })}</kbd>
          {view.query && <Tooltip text={t('catalogue:toolbar.search.clear')} asChild wrap><button type="button" className="catalogue-search-clear" aria-label={t('catalogue:toolbar.search.clear')} onClick={() => { view.setQuery(''); searchRef.current?.focus(); }}><X width={11} height={11} strokeWidth={2.5} /></button></Tooltip>}
        </div>
      </div>
      <div className={`catalogue-age-trigger${view.summary.some(item => item.family === 'age') ? ' is-active' : ''}`}>
      <Tooltip text={line(ageFilterLabel(view.filters.age))} disabled={ageOpen}><MenuPopover activation="click" open={ageOpen} onOpenChange={setAgeOpen} label={t('catalogue:age.recommended')}
        trigger={() => <Button size="sm" aria-label={t('catalogue:age.recommended')} aria-description={line(ageFilterLabel(view.filters.age))} aria-haspopup="menu" aria-expanded={ageOpen} onClick={() => { setAgeOpen(!ageOpen); setMenu(null); }}>{line(ageFilterLabel(view.filters.age))}<SlidersHorizontal className="catalogue-compact-icon" width={16} height={16} aria-hidden="true" /><ChevronDown width={12} height={12} aria-hidden="true" /></Button>}>
        <CatalogueFilterBar view={view} cards={cards} family="age" onClose={() => setAgeOpen(false)} />
      </MenuPopover></Tooltip>
      {view.summary.some(item => item.family === 'age') && <Button variant="icon" size="sm" aria-label={t('catalogue:filter.remove.label', { filter: line(ageSummary) })} onClick={() => view.dispatch({ type: 'remove', family: 'age' })}><X width={12} height={12} /></Button>}
      </div>
      <Tooltip text={t('catalogue:filters.title')} disabled={menu !== null}><MenuPopover activation="click" open={menu !== null} onOpenChange={open => setMenu(open ? menu ?? 'add' : null)} label={t('catalogue:filters.title')}
        trigger={() => <Button size="sm" aria-label={t('catalogue:filters.title')} className={`catalogue-filter-trigger${menu !== null ? ' is-active' : ''}`} aria-haspopup="menu" aria-expanded={menu !== null} onClick={() => { setAgeOpen(false); setChipMenu(null); setMenu(menu === null ? 'add' : null); }}><ListFilter width={16} height={16} />{t('catalogue:filters.title')}{view.summary.filter(item => item.family !== 'age').length > 0 && <span className="catalogue-pill-count">{view.summary.filter(item => item.family !== 'age').length}</span>}</Button>}>
        <>
          {FILTER_MENU_TOGGLES.map(criterion => { const Icon = FILTER_ICONS[criterion.family]; return <button type="button" key={criterion.family} className={`project-menu-item${criterion.family === 'missingFilesOnly' ? ' catalogue-filter-warning' : ''}`} role="menuitemcheckbox" aria-checked={view.filters[criterion.family]} onClick={() => view.dispatch({ type: 'set', family: criterion.family, value: !view.filters[criterion.family] })}><span className="catalogue-tag-check" aria-hidden="true">{view.filters[criterion.family] ? '✓' : ''}</span><Icon className="catalogue-filter-icon" width={16} height={16} aria-hidden="true" /><span>{t(criterion.key)}</span><span className="catalogue-menu-count">{counts[criterion.family]}</span></button>; })}
          <div className="project-menu-sep" />
          {filterMenuValues(folderCount).map(criterion => { const Icon = FILTER_ICONS[criterion.family]; return <MenuSubmenu key={criterion.family} label={t(criterion.key)}
            trigger={submenu => <button type="button" className="project-menu-item" role="menuitem" {...submenu}><Icon className="catalogue-filter-icon" width={16} height={16} aria-hidden="true" /><span>{t(criterion.key)}</span>{criterion.family === 'tags' && view.filters.tags.ids.length > 0 && <span className="catalogue-pill-count">{view.filters.tags.ids.length}</span>}<ChevronRight width={14} height={14} aria-hidden="true" /></button>}>
            {criterion.family === 'tags'
              ? <TagMenuEntries tags={tags} cards={cards} filterValue={view.filters.tags} onFilterChange={value => view.dispatch({ type: 'set', family: 'tags', value })} />
              : <CatalogueFilterBar view={view} cards={cards} sources={sources} family={criterion.family} onClose={() => setMenu(null)} />}
          </MenuSubmenu>; })}
        </>
      </MenuPopover></Tooltip>
    </div>;
  const viewControls = <div className="catalogue-results-controls">
      <div className="catalogue-sort">
        <Tooltip text={t(view.sort.direction === 'asc' ? 'catalogue:toolbar.sort.ascending' : 'catalogue:toolbar.sort.descending')} asChild wrap><Button variant="icon" size="sm" className="catalogue-sort-direction" onClick={view.toggleDirection} aria-label={t(view.sort.direction === 'asc' ? 'catalogue:toolbar.sort.ascending' : 'catalogue:toolbar.sort.descending')}><DirectionIcon width={15} height={15} /></Button></Tooltip>
        <CatalogueSortMenu items={sortLabels} value={view.sort.key} onChange={view.setSortKey} label={t('catalogue:toolbar.sort.label')} prefix={t('catalogue:toolbar.sort.compact')} onOpen={() => { setMenu(null); setChipMenu(null); setAgeOpen(false); }} />
      </div>
      <CatalogueViewControls view={view} />
    </div>;
  const activeFilters = (view.summary.length > 0 || view.query.trim()) && <div className="catalogue-filter-line">
      <span className="catalogue-result-count"><LeadingNumber number={view.result.counts.fiches} text={view.query.trim() ? t('catalogue:filters.searchResults', { count: view.result.counts.fiches, query: view.query }) : t('catalogue:filters.count', { count: view.result.counts.fiches, total: view.total ?? cards.length })} /></span>
      {!view.summary.length && view.query.trim() && <Button variant="ghost" size="sm" onClick={() => view.setQuery('')}>{t('catalogue:filter.reset.label')}</Button>}
      <ActiveFilterSummary tags={tags} view={view} cards={cards} sources={sources} onEdit={edit} editingFamily={chipMenu} onClose={closeEditor} renderEditor={family => <CatalogueFilterBar view={view} cards={cards} sources={sources} family={family} onClose={closeEditor} />} />
    </div>;
  return <div className="catalogue-search-tools">
    {renderChrome ? renderChrome({ searchControls, viewControls, activeFilters }) : <>{searchControls}{viewControls}{activeFilters}</>}
    {tagAnchor && <CatalogueMenuLayer><TagSubmenu cards={cards} tags={tags} targets={[]} {...tagAnchor} filterValue={view.filters.tags} onFilterChange={value => view.dispatch({ type: 'set', family: 'tags', value })} onClose={() => { setTagAnchor(null); setChipMenu(null); }} /></CatalogueMenuLayer>}
  </div>;
}
