import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { conflictChoice } from '../../../store/catalogue/importConflicts.js';
import { importIndividualChoiceNotice, importKindLabel, importValueLines } from '../../../store/catalogue/importConflictPresentation.js';
export function ImportConflictRow({ conflict, state, dispatch }) {
  const { t } = useCatalogueTranslation();
  const choice = conflictChoice(state, conflict);
  const kind = conflict.target.kind;
  const title = conflict.target.label || t('catalogue:card.untitled');
  return <fieldset className="catalogue-import-conflict">
    <legend>{t('catalogue:backupImport.conflict', { target: title, field: importKindLabel(t, kind, conflict.target.key) })}</legend>
    <p>{conflict.target.identity ? t('catalogue:backupImport.identityValue', { uuid: conflict.target.identity }) : t('catalogue:backupImport.identityUnavailable')}</p>
    {conflict.target.locator && <p>{conflict.target.locator}</p>}
    {kind.startsWith('pending') && <p>{t('catalogue:backupImport.waitingEdits')}</p>}
    {conflict.target.requiresIndividualChoice && <p>{importIndividualChoiceNotice(t, conflict.target.individualChoiceReason)}</p>}
    <dl><dt>{t('catalogue:backupImport.local')}</dt><dd>{importValueLines(t, kind, conflict.local, true).map((line, i) => <p key={i}>{line}</p>)}</dd>
      <dt>{t('catalogue:backupImport.incoming')}</dt><dd>{importValueLines(t, kind, conflict.incoming).map((line, i) => <p key={i}>{line}</p>)}</dd></dl>
    <label><input type="radio" name={`conflict-${conflict.id}`} checked={choice === 'local'} onChange={() => dispatch({ type: 'choice', id: conflict.id, choice: 'local' })} />{t('catalogue:backupImport.keepLocal')}</label>
    <label><input type="radio" name={`conflict-${conflict.id}`} checked={choice === 'incoming'} onChange={() => dispatch({ type: 'choice', id: conflict.id, choice: 'incoming' })} />{t('catalogue:backupImport.useIncoming')}</label>
  </fieldset>;
}
