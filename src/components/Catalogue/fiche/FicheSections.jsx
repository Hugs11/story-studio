import { dateCell, textCell } from '../../../store/catalogue/detailsRow.js';
import { editButton, simulateCommand } from '../../../store/catalogue/cardActions.js';
import { CopyUuid } from './CopyUuid.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { Button } from '../../common/Button.jsx';
import { X, Plus, Play, SquarePen } from '../../icons/LucideLocal.jsx';
import { languageLabel } from '../../../store/catalogue/languageOptions.js';
import { fieldPencil } from '../FieldPencil.jsx';

/**
 * Language/author/producer/bonus, tags and footer: plain render helpers (not
 * components) shared by the inspector and the large modal, so the inspector's
 * element tree stays flat. Each value carries the discreet hover pencil.
 */
export function ficheFields({ t, cell, card, detail, row, editing, editor, onEditField, idPrefix = 'catalogue-fiche', entries }) {
  const unknown = t('catalogue:details.value.notProvided');
  const extra = field => textCell(detail?.fields?.find(item => item.field === field && !item.language)?.effective?.value ?? card[field]);
  // `entries` lets the multiple-selection panel supply its own values (a `mixed` kind included).
  return <dl className="catalogue-fiche-fields">{(entries ?? [
    ['language', t('catalogue:details.column.language'), row.language],
    ['author', t('catalogue:fiche.edit.field.author'), row.author],
    ['producer', t('catalogue:fiche.edit.field.producer'), extra('producer')],
    ['bonus', t('catalogue:fiche.edit.field.bonus'), extra('bonus')],
  ]).map(([field, label, value]) => {
    const missing = value.kind === 'missing';
    const shown = value.kind === 'mixed' ? <span>{t('catalogue:selection.inline.mixed')}</span>
      : <><span aria-hidden={missing || undefined} className={missing ? 'catalogue-fiche-value-missing' : undefined}>{missing ? unknown : field === 'language' && value.kind === 'text' ? languageLabel(value.value, t) : cell(value)}</span>{missing && <span className="catalogue-visually-hidden">{t('catalogue:details.value.notProvidedAccessible')}</span>}</>;
    return <div key={field} className="catalogue-fiche-editable"><dt>{label}</dt><dd>{onEditField ? editableField({ t, field, label, content: shown, editing, editor, onEditField, idPrefix }) : shown}</dd></div>;
  })}</dl>;
}

export function ficheTags({ t, card, dataBusy, onTags, onFilterTag, onRemoveTag }) {
  return <section><h3 className="catalogue-section-title">{t('catalogue:tags.title')}</h3>
  <div className="catalogue-card-tags">{card.tags?.map(tag => <span className="catalogue-format-tag catalogue-card-tag" key={tag.id}><Tooltip text={tag.label} asChild whenTruncated><button type="button" className="catalogue-tag-label" onClick={() => onFilterTag?.(tag.id)}>{tag.label}</button></Tooltip><Button variant="icon" size="sm" disabled={dataBusy} aria-label={t('catalogue:fiche.tags.remove', { label: tag.label })} onClick={() => onRemoveTag?.(tag.id)}><X width={12} height={12} /></Button></span>)}<Button size="sm" className="catalogue-fiche-add-tag" aria-label={t('catalogue:fiche.tags.addLabel')} onClick={onTags} disabled={dataBusy} aria-haspopup="menu"><Plus width={12} height={12} />{t('catalogue:fiche.tags.add')}</Button></div></section>;
}

export function ficheFooter({ t, cell, card, onCopyUuid }) {
  if (!(card.uuids?.length > 0 || dateCell(card.addedAt).kind !== 'missing')) return null;
  return <footer className="catalogue-fiche-footer">
    {card.uuids?.length > 0 && <CopyUuid uuids={card.uuids} onCopy={onCopyUuid} />}
    {dateCell(card.addedAt).kind !== 'missing' && <div>{t('catalogue:fiche.footer.addedOn', { date: cell(dateCell(card.addedAt)) })}</div>}
  </footer>;
}

/**
 * Field value with its hover pencil, replaced by the inline editor while edited.
 * Plain render helpers (not components) shared by the inspector and the large
 * modal, so the inspector's element tree stays flat.
 */
export function editableField({ t, field, label, content, editing, editor, onEditField, idPrefix = 'catalogue-fiche' }) {
  return editing === field ? editor : <>{content}{editPencil({ t, field, label, onEditField, idPrefix })}</>;
}

/** The pencil alone, for a value whose editor replaces only part of its section (description). */
export function editPencil({ t, field, label, onEditField, idPrefix = 'catalogue-fiche' }) {
  const text = t('catalogue:fiche.inline.editField', { field: label });
  return fieldPencil({ id: `${idPrefix}-pencil-${field}`, label: text, onClick: event => onEditField(field, event.currentTarget) });
}

/** Simulate and open-in-editor buttons, shared by the inspector and the large modal. */
export function ficheOpenActions({ t, card, onEdit, onSimulate, idPrefix = 'catalogue-fiche' }) {
  const edit = editButton(card, card.exemplars);
  const simulate = simulateCommand(card, card.exemplars);
  return <div className="catalogue-fiche-open-actions" role="group">
    {onSimulate && simulate.enabled && <Button id={`${idPrefix}-simulate`} variant="primary-violet" aria-haspopup={simulate.choice ? 'dialog' : undefined} onClick={event => onSimulate(simulate, event.currentTarget)}><Play width={15} height={15} />{t('catalogue:actions.simulate.label')}</Button>}
    {onEdit && edit.enabled && <Button id={`${idPrefix}-edit`} onClick={event => onEdit(edit, event.currentTarget)}><SquarePen width={16} height={16} />{t('catalogue:fiche.panel.openEditor')}</Button>}
  </div>;
}

