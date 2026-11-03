import { AGE_LIMIT } from '../../../store/catalogue/entryModel.js';
import { AGE_PRESETS } from '../../../store/catalogue/ageFilter.js';
import { createContext, useContext, useId, useState } from 'react';
import { textCell } from '../../../store/catalogue/detailsRow.js';
import { FieldEditor } from '../fiche/FieldEditor.jsx';
import { inlineEditShell } from '../fiche/inlineEditShell.jsx';
import { ficheFields } from '../fiche/FicheSections.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { validLanguage } from '../../../store/catalogue/languageOptions.js';
import { SELECTION_INFO_FIELDS, selectionFieldValue, selectionMetadataMutation } from '../../../store/catalogue/selectionPresentation.js';
import { Button } from '../../common/Button.jsx';

const EDITOR_FIELDS = {
  language: { id: 'selection-language', labelKey: 'catalogue:details.column.language' },
  author: { id: 'selection-author', labelKey: 'catalogue:fiche.edit.field.author' },
  producer: { id: 'selection-producer', labelKey: 'catalogue:fiche.edit.field.producer' },
  bonus: { id: 'selection-bonus', labelKey: 'catalogue:fiche.edit.field.bonus' },
};

export const SelectionControlsContext = createContext({});
export function useSelectionControls() { return useContext(SelectionControlsContext); }

/** Immediate metadata edits use the same revision-aware mutation as bulk editing. */
export function SelectionMetadataControls({ cards, busy, error, mutate }) {
  const { t, cell } = useCatalogueTranslation();
  const id = useId();
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [report, setReport] = useState(null);
  const [ageDraft, setAgeDraft] = useState(null);
  async function apply(changes) {
    if (busy || !mutate || !cards.length) return;
    const result = await mutate(selectionMetadataMutation(cards, changes));
    setReport(result?.report ?? null);
  }
  const labels = { language: t('catalogue:details.column.language'), author: t('catalogue:fiche.edit.field.author'), producer: t('catalogue:fiche.edit.field.producer'), bonus: t('catalogue:fiche.edit.field.bonus') };
  const entries = SELECTION_INFO_FIELDS.map(field => {
    const info = selectionFieldValue(cards, field);
    return [field, labels[field], info.kind === 'common' ? textCell(info.value) : info.kind === 'mixed' ? { kind: 'mixed' } : textCell('')];
  });
  const initial = field => { const info = selectionFieldValue(cards, field); return info.kind === 'common' ? info.value : ''; };
  const trimmed = draft.trim();
  const invalid = editing && trimmed !== '' && (editing === 'language' ? !validLanguage(trimmed) : [...trimmed].length > 2000);
  const close = () => { const trigger = `catalogue-selection-pencil-${editing}`; setEditing(null); requestAnimationFrame(() => document.getElementById(trigger)?.focus()); };
  // An unchanged value, or an empty one over a mixed field, changes nothing: no call, no accidental overwrite.
  const save = async () => {
    const field = editing;
    if (!field || busy) return;
    if (trimmed === initial(field).trim()) { close(); return; }
    close();
    await apply({ [field]: trimmed === '' ? { state: 'cleared' } : { state: 'defined', value: trimmed } });
  };
  // One age for the whole selection: the common one when it is not already a button, otherwise empty.
  const commonAge = (() => { const ages = new Set(cards.map(card => card.age?.min)); const [only] = ages; return ages.size === 1 && Number.isInteger(only) && !AGE_PRESETS.includes(only) ? String(only) : ''; })();
  const ageText = ageDraft?.trim() ?? '';
  const ageInvalid = ageDraft !== null && ageText !== '' && !(/^\d+$/.test(ageText) && Number(ageText) <= AGE_LIMIT);
  const closeAge = () => { setAgeDraft(null); requestAnimationFrame(() => document.getElementById(`${id}-age-other`)?.focus()); };
  const saveAge = async () => {
    if (ageDraft === null || busy) return;
    closeAge();
    if (ageText !== '') await apply({ ageMin: { state: 'defined', value: Number(ageText) }, ageMax: { state: 'cleared' } });
  };
  const ageEditor = ageDraft !== null && inlineEditShell({ t, invalid: ageInvalid, saving: busy, saveDisabled: false, onSave: () => { void saveAge(); }, onCancel: closeAge,
    children: <FieldEditor field={{ id: 'selection-age', labelKey: 'catalogue:fiche.inline.age' }} entry={{ field: 'ageMin', state: ageDraft === '' ? 'cleared' : 'defined', value: ageDraft }} busy={busy}
      error={ageInvalid ? 'catalogue:fiche.edit.invalid' : undefined} onChange={patch => setAgeDraft(patch.value ?? '')} /> });
  const entry = { field: editing, state: draft === '' ? 'cleared' : 'defined', value: draft };
  const editor = editing && inlineEditShell({ t, invalid, saving: busy, saveDisabled: false, onSave: () => { void save(); }, onCancel: close,
    children: <FieldEditor key={editing} field={EDITOR_FIELDS[editing]} entry={entry} busy={busy}
      error={invalid ? 'catalogue:fiche.edit.invalid' : undefined} onChange={patch => setDraft(patch.value ?? '')} /> });
  const onEditField = field => { if (busy) return; setDraft(initial(field)); setEditing(field); };
  return <div className="catalogue-selection-metadata">
    <div className="catalogue-selection-metadata-row"><span id={`${id}-age`} className="catalogue-selection-metadata-label">{t('catalogue:fiche.inline.age')}</span>
      {ageEditor || <div className="catalogue-selection-ages" role="group" aria-labelledby={`${id}-age`}>{AGE_PRESETS.map(age => {
        const count = cards.filter(card => card.age?.min === age).length;
        return <Button key={age} size="sm" disabled={busy} aria-label={t('catalogue:details.age.from', { count: age })} aria-pressed={count === cards.length ? true : count ? 'mixed' : false}
          className={count ? 'is-present' : ''} onClick={() => { void apply({ ageMin: { state: 'defined', value: age }, ageMax: { state: 'cleared' } }); }}>{age}</Button>;
      })}<Button id={`${id}-age-other`} size="sm" disabled={busy} aria-label={t('catalogue:selection.inline.otherAge')} aria-haspopup="dialog" onClick={() => setAgeDraft(commonAge)}>…</Button></div>}
    </div>
    <section><h3 className="catalogue-fiche-section-title catalogue-section-title">{t('catalogue:fiche.modal.information')}</h3>
      {ficheFields({ t, cell, entries, editing, editor, onEditField, idPrefix: 'catalogue-selection' })}
    </section>
    {error && <p role="alert">{presentCatalogueError(error).message}</p>}
    {report?.rejected?.length > 0 && <div role="alert"><p>{t('catalogue:data.bulk.rejected')}</p><ul>{report.rejected.map(item => <li key={item.ficheId}>{item.ficheId}</li>)}</ul></div>}
  </div>;
}
