import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { shownFieldValue, editFieldValue, sourceFieldText } from '../../../store/catalogue/ficheEditing.js';
import { LANGUAGE_OPTIONS } from '../../../store/catalogue/languageOptions.js';
import { Button } from '../../common/Button.jsx';
import { Select } from '../../common/Select.jsx';

/**
 * Language is chosen from the list of content languages, never typed: the
 * filter relies on it. The current code stays offered when it is not listed,
 * and the empty choice clears the field intentionally.
 */
function languageInput({ t, id, label, value, busy, error, change }) {
  const listed = LANGUAGE_OPTIONS.some(([code]) => code === value);
  return <Select autoFocus variant="pill" id={id} aria-label={label} value={value} readOnly={busy} invalid={!!error} onChange={next => { if (!busy) change(next); }} options={[
    { value: '', label: t('catalogue:fiche.edit.language.none') },
    ...(value && !listed ? [{ value, label: value }] : []),
    ...LANGUAGE_OPTIONS.map(([code, key]) => ({ value: code, label: t(key) })),
  ]} />;
}

export function FieldEditor({ field, entry, original = null, onChange, error, conflict, onResolve, busy }) {
  const { t } = useCatalogueTranslation();
  const id = `metadata-${encodeURIComponent(field.id)}`;
  const change = value => onChange(editFieldValue(value, original));
  const age = entry.field === 'ageMin';
  // A source description keeps the pack's markup; the editor starts from the displayed text.
  const value = entry.state === 'source' ? sourceFieldText(entry) : shownFieldValue(entry);
  return <div className={`catalogue-field-editor${entry.field === 'language' ? ' catalogue-field-editor--compact' : ''}`}>
    <label className="catalogue-visually-hidden" htmlFor={id}>{t(field.labelKey)}</label>
    <div className="catalogue-inline-input">
      {age && <Button variant="icon" size="sm" disabled={busy || Number(value) <= 0} aria-label={t('catalogue:fiche.age.decrease')} onClick={() => change(String(Math.max(0, (Number(value) || 0) - 1)))}>−</Button>}
      {entry.field === 'language' ? languageInput({ t, id, label: t(field.labelKey), value, busy, error, change })
        : entry.field === 'description' ? <textarea autoFocus id={id} value={value} readOnly={busy} aria-invalid={!!error} aria-keyshortcuts="Control+Enter" onChange={e => change(e.target.value)} />
          : <input autoFocus id={id} type={age ? 'number' : 'text'} min={age ? 0 : undefined} max={age ? 18 : undefined} step={age ? 1 : undefined} value={value} readOnly={busy} aria-invalid={!!error} onChange={e => change(e.target.value)} />}
      {age && <Button variant="icon" size="sm" disabled={busy || Number(value) >= 18} aria-label={t('catalogue:fiche.age.increase')} onClick={() => change(String(Math.min(18, (Number(value) || 0) + 1)))}>+</Button>}
    </div>
    {error && <p role="alert">{t(error)}</p>}
    {conflict && <div role="group" aria-label={t('catalogue:fiche.edit.conflict')}>
      <p>{t('catalogue:fiche.edit.conflict')}</p>
      <dl><dt>{t('catalogue:fiche.edit.yours')}</dt><dd>{entry.value}</dd><dt>{t('catalogue:fiche.edit.server')}</dt><dd>{shownFieldValue(conflict.theirs)}</dd></dl>
      <Button onClick={() => onResolve('ours')}>{t('catalogue:fiche.edit.keepMine')}</Button><Button onClick={() => onResolve('server')}>{t('catalogue:fiche.edit.useServer')}</Button>
    </div>}
  </div>;
}
