import { useEffect, useRef } from 'react';
import { useCatalogueCard } from '../../../hooks/useCatalogueCard.js';
import { useCatalogueDraft } from '../../../hooks/useCatalogueDraft.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { editableFields } from '../../../store/catalogue/ficheEditing.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { FieldEditor } from './FieldEditor.jsx';
import { inlineEditShell } from './inlineEditShell.jsx';
import './FicheEditPanel.css';

export function FicheEditSurface({ card, draft, dispatch, errors = {}, saving = false, dirty = false, onSave, onCancel, field: selectedField }) {
  const { t } = useCatalogueTranslation();
  const fields = editableFields(card).filter(field => field.field === (selectedField === 'age' ? 'ageMin' : selectedField));
  const invalid = Object.keys(errors).length > 0 || Object.keys(draft.conflicts).length > 0;
  return inlineEditShell({ t, invalid, saving, saveDisabled: !dirty, onSave, onCancel, children: fields.map(field => <FieldEditor key={field.id} field={field} entry={draft.entries[field.id]} original={draft.original[field.id]} busy={saving} error={errors[field.id]} conflict={draft.conflicts[field.id]}
      onResolve={keep => dispatch({ type: 'conflict', id: field.id, keep })} onChange={patch => dispatch({ type: 'edit', id: field.id, patch })} />) });
}
export function FicheEditPanel({ ficheId, field, onBeforeAbandon, onDone, onCancel }) {
  const { t } = useCatalogueTranslation(); const { card, error: loadError, reload } = useCatalogueCard(ficheId);
  const state = useCatalogueDraft(card, reload, undefined, { singleAge: true });
  const pendingSave = useRef(null);
  const commit = () => {
    if (!pendingSave.current) pendingSave.current = state.save().then(saved => {
      if (saved) onDone();
      return saved;
    }).finally(() => { pendingSave.current = null; });
    return pendingSave.current;
  };
  useEffect(() => {
    onBeforeAbandon.current = commit;
    return () => { onBeforeAbandon.current = null; };
  });
  const failure = state.error ?? loadError;
  return <>
    {failure && <p role="alert">{presentCatalogueError(failure).message}</p>}
    {!card || !state.draft ? <p role="status">{t('catalogue:fiche.edit.loading')}</p> : <FicheEditSurface card={card} field={field} {...state} onCancel={onCancel}
      onSave={commit} />}
  </>;
}
