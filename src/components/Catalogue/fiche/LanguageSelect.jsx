import { useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { Select } from '../../common/Select.jsx';
import { LANGUAGE_OPTIONS } from '../../../store/catalogue/languageOptions.js';

export function LanguageSelect({ value, onChange, busy, id, describedBy, invalid, emptyLabel }) {
  const { t } = useCatalogueTranslation();
  const [mode, setMode] = useState(() => ({ value, custom: !(emptyLabel && !value) && !LANGUAGE_OPTIONS.some(([code]) => code === value) }));
  // Local edits remember their mode even when a common code is typed in Other.
  // A different value from a reload or conflict resolution chooses its own mode.
  const custom = mode.value === value ? mode.custom : !(emptyLabel && !value) && !LANGUAGE_OPTIONS.some(([code]) => code === value);
  if (mode.value !== value) setMode({ value, custom });
  const change = (next, nextCustom) => {
    setMode({ value: next, custom: nextCustom });
    onChange(next);
  };
  return <>
    <Select id={id} aria-label={t('catalogue:fiche.edit.field.language')} value={custom ? 'custom' : value} aria-describedby={describedBy} readOnly={busy} options={[
      ...(emptyLabel ? [{ value: '', label: emptyLabel }] : []),
      ...LANGUAGE_OPTIONS.map(([code, key]) => ({ value: code, label: t(key) })),
      { value: 'custom', label: t('catalogue:fiche.edit.otherLanguage') },
    ]} onChange={next => { if (!busy) change(next === 'custom' ? '' : next, next === 'custom'); }} />
    {custom && <input aria-label={t('catalogue:fiche.edit.otherLanguage')} value={value} readOnly={busy} aria-describedby={describedBy} aria-invalid={invalid} onChange={event => { if (!busy) change(event.target.value, true); }} />}
  </>;
}
