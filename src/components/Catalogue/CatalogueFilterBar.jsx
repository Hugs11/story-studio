import { Trans } from 'react-i18next';
import { useId, useMemo, useState } from 'react';
import { AGE_LIMIT } from '../../store/catalogue/entryModel.js';
import { validateAgeFilter, AGE_PRESETS } from '../../store/catalogue/ageFilter.js';
import { MenuPopover } from '../layout/MenuPopover.jsx';
import { Button } from '../common/Button.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { sourceFolderOptions } from '../../store/catalogue/sourceView.js';
import { X, ChevronDown } from '../icons/LucideLocal.jsx';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { filterValueCounts } from '../../store/catalogue/filterValueCounts.js';
import { compactTagLabel } from '../../store/catalogue/filterPalette.js';
import { languageLabel } from '../../store/catalogue/languageOptions.js';
import { FAMILY_CONTROLS, filterControls } from '../../store/catalogue/filterState.js';

export const FILTER_VALUE_KEYS = Object.freeze({
  modifiedSince: 'catalogue:generation.modified.reason',
  project: 'catalogue:format.project.label', zip: 'catalogue:format.zip.label',
  sevenZip: 'catalogue:format.sevenZip.label', folder: 'catalogue:format.folder.label',
  simple: 'catalogue:filter.type.simple', menus: 'catalogue:filter.type.menus', graph: 'catalogue:filter.type.graph',
  description: 'catalogue:filter.missing.description', author: 'catalogue:filter.missing.author', language: 'catalogue:filter.missing.language',
  title: 'catalogue:filter.missing.title', age: 'catalogue:filter.missing.age', cover: 'catalogue:filter.missing.cover',
});
export function useFilterLabels(cards, sources, tags = []) {
  const { t, line } = useCatalogueTranslation();
  const controls = filterControls(cards);
  const knownTags = [...tags, ...controls.find(control => control.family === 'tags').values];
  const labelValue = (family, value) => {
    if (family === 'sourceIds') return sourceFolderOptions(sources).find(source => source.id === value)?.label ?? sources.find(source => source.id === value)?.path ?? value;
    if (family === 'tags') return knownTags.find(tag => tag.id === value)?.label ?? value;
    if (family === 'languages') return languageLabel(value, t);
    return FILTER_VALUE_KEYS[value] ? t(FILTER_VALUE_KEYS[value]) : value;
  };
  const summaryLabel = item => {
    if (item.family === 'tags') return t('catalogue:filter.summary.values', { family: line(item), values: compactTagLabel(item.params.values, knownTags) });
    const values = item.params.values?.map(value => labelValue(item.family, value));
    return values?.length ? t('catalogue:filter.summary.values', { family: line(item), values: values.join(', ') }) : line(item);
  };
  return { summaryLabel, labelValue };
}

export function CatalogueFilterBar({ view, family, onClose, cards = [], sources = [] }) {
  const { t, line } = useCatalogueTranslation();
  const id = useId();
  const [draft, setDraft] = useState(null);
  const control = useMemo(() => {
    const found = filterControls(cards).find(item => item.family === family);
    return found?.family === 'sourceIds' ? { ...found, values: sourceFolderOptions(sources) } : found;
  }, [cards, family, sources]);
  const counts = useMemo(() => control ? filterValueCounts(cards, view, control) : {}, [cards, view.filters, view.query, control]);
  const set = value => view.dispatch({ type: 'set', family, value });
  if (family === 'age') {
    const applied = view.filters.age;
    const age = draft?.source === applied ? draft.value : applied;
    const validation = validateAgeFilter(age);
    const apply = value => { setDraft(null); set(value); };
    const change = (field, raw, badInput) => {
      const value = { ...age, [field]: badInput ? NaN : raw === '' ? null : Number(raw) };
      setDraft({ source: applied, value });
      if (validateAgeFilter(value).valid) set(value);
    };
    const errorId = `${id}-error`;
    return <div className="catalogue-age-editor">
      <div className="catalogue-age-heading"><strong>{t('catalogue:age.recommended')}</strong><span className="catalogue-count">{t('catalogue:toolbar.count.packs', { count: view.result?.counts.fiches ?? 0 })}</span></div>
      <p>{t('catalogue:age.child')}</p>
      <div className="catalogue-age-presets" role="group" aria-label={t('catalogue:filter.age.label')}>
        {AGE_PRESETS.map(max => <Button key={max} size="sm" aria-pressed={age.max === max && age.min === null} onClick={() => { const value = { ...age, min: null, max }; if (validateAgeFilter(value).valid) apply(value); }}>{max}</Button>)}
      </div>
      <p className="catalogue-age-explanation">{applied.max !== null ? t('catalogue:age.help', { count: applied.max }) : t('catalogue:palette.ageExplanation')}</p>
      <div className="catalogue-age-precise">
        <p>{t('catalogue:age.precise')}</p>
        <div className="catalogue-age-range">
          <Trans t={t} i18nKey="catalogue:age.preciseRange" count={Number.isFinite(age.max) ? age.max : 2} components={{
            minimum: <input type="number" min={0} max={AGE_LIMIT} step={1} placeholder="—" value={Number.isNaN(age.min) ? '' : age.min ?? ''} aria-label={t('catalogue:filter.age.minimum')} aria-invalid={!validation.valid || undefined} aria-describedby={validation.error ? errorId : undefined} onChange={event => change('min', event.target.value, event.target.validity?.badInput)} />,
            maximum: <input type="number" min={0} max={AGE_LIMIT} step={1} placeholder="—" value={Number.isNaN(age.max) ? '' : age.max ?? ''} aria-label={t('catalogue:filter.age.maximum')} aria-invalid={!validation.valid || undefined} aria-describedby={validation.error ? errorId : undefined} onChange={event => change('max', event.target.value, event.target.validity?.badInput)} />,
          }} />
        </div>
        {validation.error && <p id={errorId} className="catalogue-age-error" role="alert">{line(validation.error)}</p>}
      </div>
      <div className="catalogue-age-footer"><Button variant="ghost" size="sm" onClick={() => apply({ min: null, max: null })}>{t('catalogue:age.clear')}</Button></div>
    </div>;
  }
  if (control) return <>{control.values.map(item => {
    const value = typeof item === 'object' ? item.id : item;
    const button = <button type="button" key={value} className="project-menu-item" role="menuitemcheckbox" aria-checked={view.filters[family].includes(value)} onClick={() => set(view.filters[family].includes(value) ? view.filters[family].filter(item => item !== value) : [...view.filters[family], value])}>{typeof item === 'object' ? item.label : family === 'languages' ? languageLabel(value, t) : FILTER_VALUE_KEYS[value] ? t(FILTER_VALUE_KEYS[value]) : value}<span className="catalogue-menu-count">{counts[value]}</span></button>;
    return typeof item === 'object' ? <Tooltip key={value} text={item.path} asChild>{button}</Tooltip> : button;
  })}</>;
  const key = family === 'favoritesOnly' ? 'catalogue:filter.favorites.only' : family === 'incompleteOnly' ? 'catalogue:palette.incomplete' : family === 'hideOfficial' ? 'catalogue:filter.hideOfficial.label' : 'catalogue:filter.missingFiles.label';
  return <button type="button" className="project-menu-item" role="menuitemcheckbox" aria-checked={!!view.filters[family]} onClick={() => { set(!view.filters[family]); onClose(); }}>{t(key)}</button>;
}

export function ActiveFilterSummary({ view, cards, sources = [], tags = [], onEdit, editingFamily, onClose, renderEditor }) {
  const { summaryLabel, labelValue } = useFilterLabels(cards, sources, tags);
  const { t } = useCatalogueTranslation();
  if (!view.summary.length) return null;
  return <div className="catalogue-filter-summary" role="group" aria-label={t('catalogue:filter.summary.label')}>
    {view.summary.filter(item => item.family !== 'age').map((item, index) => <div key={`${item.family}-${index}`} className="catalogue-filter-chip">
      <MenuPopover activation="click" open={editingFamily === item.family && item.family !== 'tags'} onOpenChange={open => { if (!open) onClose?.(); }} label={summaryLabel(item)} title={summaryLabel(item)}
        trigger={() => <button type="button" className="catalogue-filter-chip-label" aria-haspopup="menu" aria-expanded={editingFamily === item.family} onClick={event => editingFamily === item.family ? onClose?.() : onEdit?.(item.family, event.currentTarget)}>{item.params.values?.length > 0 && <small>{t(FAMILY_CONTROLS.find(control => control.family === item.family)?.key ?? item.key)}</small>}<span>{item.params.values?.length ? item.params.values.map(value => labelValue(item.family, value)).join(', ') : summaryLabel(item)}</span><ChevronDown width={12} height={12} /></button>}>
        {editingFamily === item.family && renderEditor?.(item.family)}
      </MenuPopover>
      <button type="button" className="catalogue-filter-chip-remove" aria-label={t('catalogue:filter.remove.label', { filter: summaryLabel(item) })} onClick={() => view.dispatch({ type: 'remove', family: item.family, key: item.key })}><X width={12} height={12} aria-hidden="true" /></button>
    </div>)}
    <Button variant="ghost" size="sm" onClick={() => view.dispatch({ type: 'reset' })}>{t('catalogue:filter.reset.label')}</Button>
  </div>;
}
