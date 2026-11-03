import { useId } from 'react';
import { useHomeTranslation } from '../../i18n/useHomeTranslation.js';

export function AggregateDestinationChoice({ destination, onChoose, busy = false }) {
  const { t } = useHomeTranslation();
  const name = useId();
  return <fieldset className="aggregate-destination" aria-busy={busy}>
    <legend>{t('home:aggregate.destination.title')}</legend>
    <label><input type="radio" name={name} value="editor" checked={destination === 'editor'} disabled={busy} onChange={() => onChoose('editor')} />{t('home:aggregate.destination.editor')}</label>
    <label><input type="radio" name={name} value="generate" checked={destination === 'generate'} disabled={busy} onChange={() => onChoose('generate')} />{t('home:aggregate.destination.generate')}</label>
    <p>{t('home:aggregate.destination.hint')}</p>
  </fieldset>;
}

export function AggregateGenerationReview({ folder, fileName, files, onConfirm, onCancel }) {
  const { t } = useHomeTranslation();
  return <section className="aggregate-review" aria-labelledby="aggregate-review-title">
    <h2 id="aggregate-review-title" tabIndex={-1} ref={element => element?.focus()}>{t('home:aggregate.review.title')}</h2>
    <p>{t('home:aggregate.review.folder', { folder })}</p>
    <p>{t('home:aggregate.review.file', { fileName })}</p>
    <p>{t('home:aggregate.review.replace')}</p>
    <ul>{files.map((file, index) => <li key={index}>{file}</li>)}</ul>
    <button type="button" className="funnel-btn" onClick={onCancel}>{t('common:dialog.cancel.label')}</button>
    <button type="button" className="funnel-btn funnel-btn-primary" onClick={onConfirm}>{t('home:aggregate.generation.action')}</button>
  </section>;
}
