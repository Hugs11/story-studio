import { Trans } from 'react-i18next';
import { useId, useState } from 'react';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { durationCell } from '../../../store/catalogue/detailsRow.js';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { Star, X, Plus, Layers, Tag, CircleDashed, Send } from '../../icons/LucideLocal.jsx';
import { FavoriteStar } from '../FavoriteStar.jsx';
import { CoverImage } from '../views/CoverImage.jsx';
import { MenuPopover } from '../../layout/MenuPopover.jsx';
import { SelectionMetadataControls, useSelectionControls } from '../selection/SelectionControls.jsx';
import { selectionFavoriteState, selectionSummary, selectionTagCounts, selectionTagMutation, showSelectionBar } from '../../../store/catalogue/selectionPresentation.js';
import { commandKeyLabel } from '../../../utils/platformKeys.js';
import './SelectionPanel.css';

const PREVIEW_LIMIT = 4;

/** Keeps refused actions reachable so their reason can be read at the keyboard. */
export function SelectionAction({ action, onAction, children, pressed, variant, size = 'sm', className = '' }) {
  const { t } = useCatalogueTranslation();
  const reasonId = useId();
  const reason = action.enabled ? null : action.reasonText ?? (action.reasonKey ? t(action.reasonKey) : null);
  const button = <Button size={size} variant={variant} className={`catalogue-selection-panel-action ${className}`} aria-pressed={pressed}
    aria-disabled={!action.enabled || undefined} aria-describedby={reason ? reasonId : undefined}
    onClick={() => { if (action.enabled) onAction?.(action.id); }}>{children ?? t(action.labelKey)}</Button>;
  return <>{reason ? <Tooltip text={reason} asChild wrap>{button}</Tooltip> : button}
    {reason && <span id={reasonId} className="catalogue-visually-hidden">{reason}</span>}</>;
}

export function SelectionPanelActions({ actions = [], onAction, cards = [] }) {
  const { t } = useCatalogueTranslation();
  const reasonId = useId();
  const favorite = actions.find(action => action.id === 'favorite');
  if (!cards.length) return null;
  const favoriteState = selectionFavoriteState(cards);
  const reason = favorite && !favorite.enabled ? favorite.reasonText ?? (favorite.reasonKey ? t(favorite.reasonKey) : null) : null;
  return favorite ? <><FavoriteStar favorite={favoriteState.pressed === true} busy={!favorite.enabled}
    describedBy={reason ? reasonId : undefined} label={t(favoriteState.labelKey, { count: cards.length })} onChange={() => onAction?.(favorite.id)} />
    {reason && <span id={reasonId} className="catalogue-visually-hidden">{reason}</span>}</> : null;
}

function SelectionTags({ cards, tags, onTags, actions }) {
  const { t } = useCatalogueTranslation();
  const { mutate, busy } = useSelectionControls();
  const action = actions.find(action => action.id === 'tags');
  return <div className="catalogue-selection-tag-list">
    {selectionTagCounts(cards, tags).map(tag => <Button key={tag.id} size="sm" disabled={busy} className={`catalogue-selection-tag ${tag.count < cards.length ? 'is-partial' : ''}`}
      aria-label={tag.count === cards.length ? t('catalogue:selection.inline.removeTag', { label: tag.label }) : t('catalogue:selection.inline.applyTag', { label: tag.label })}
      onClick={() => { if (!busy) void mutate?.(selectionTagMutation(cards, tag)); }}>
      {tag.label}{tag.count < cards.length ? <span>{t('catalogue:selection.panel.tagCount', { count: tag.count, total: cards.length })}</span> : <X width={12} height={12} />}
    </Button>)}
    <Button size="sm" className="catalogue-fiche-add-tag" aria-label={t('catalogue:fiche.tags.addLabel')} aria-haspopup="menu" disabled={busy || action?.enabled === false} onClick={onTags}><Plus width={12} height={12} />{t('catalogue:fiche.tags.add')}</Button>
  </div>;
}

export function FicheSelectionSummary({ cards, tags = [], onClose, onTags, actions = [], onAction }) {
  const { t, cell } = useCatalogueTranslation();
  const controls = useSelectionControls();
  const summary = selectionSummary(cards);
  const assemble = actions.find(action => action.id === 'assemble');
  const send = actions.find(action => action.id === 'luniiSend');
  if (!cards.length) return null;
  const previews = cards.length > PREVIEW_LIMIT ? cards.slice(0, PREVIEW_LIMIT - 1) : cards;
  return <div className="catalogue-fiche-content catalogue-selection-panel">
    <header className="catalogue-selection-header catalogue-fiche-titlebar"><h2 id="catalogue-fiche-title" tabIndex={-1}>{t('catalogue:fiche.panel.selected', { count: cards.length })}</h2>
      <SelectionPanelActions cards={cards} actions={actions} onAction={onAction} />
      <Button variant="icon" size="sm" aria-label={t('catalogue:fiche.close.label')} onClick={onClose}><X width={16} height={16} /></Button>
    </header>
    <div className="catalogue-selection-preview">
      {previews.map(card => <CoverImage key={card.id} ficheId={card.id} coverSignature={card.coverSignature} />)}
      {cards.length > PREVIEW_LIMIT && <span className="catalogue-selection-preview-more">+{cards.length - previews.length}</span>}
    </div>
    <p className="catalogue-selection-duration">
      {summary.duration !== null && t('catalogue:fiche.panel.totalDuration', { duration: cell(durationCell(summary.duration)) })}
      {summary.duration !== null && summary.min !== null && ' · '}
      {summary.min !== null && (summary.min === summary.max ? t('catalogue:details.age.from', { count: summary.min }) : t('catalogue:selection.inline.ageRange', { min: summary.min, max: summary.max }))}
    </p>
    <div className="catalogue-selection-production">{assemble && <div className="catalogue-selection-assemble"><SelectionAction variant="primary" action={assemble} onAction={onAction}><Layers width={16} height={16} />{t('catalogue:selection.inline.assemble', { count: cards.length })}</SelectionAction><p>{t('catalogue:selection.inline.assemblyHelp', { count: cards.length })}</p></div>}
      {send && <div className="catalogue-fiche-send"><SelectionAction action={send} size="md" className="catalogue-send catalogue-send--fiche" onAction={onAction}><Send width={16} height={16} />{t('catalogue:lunii.sendSelection')}</SelectionAction></div>}
    </div>
    <section><h3 className="catalogue-section-title">{t('catalogue:tags.title')}</h3><SelectionTags cards={cards} tags={tags} actions={actions} onTags={onTags} /></section>
    <section><h3 className="catalogue-section-title">{t('catalogue:selection.inline.edit', { count: cards.length })}</h3><SelectionMetadataControls cards={cards} {...controls} /></section>
    <footer className="catalogue-selection-shortcuts"><Trans t={t} i18nKey="catalogue:selection.inline.shortcuts" values={{ command: commandKeyLabel() }} components={{ key: <kbd className="kbd kbd--hint" />, gesture: <span /> }} /></footer>
  </div>;
}

export function SelectionFloatingBar({ panelVisible, cards, visible = showSelectionBar(panelVisible, cards.length), actions, onAction, onTags, onClear }) {
  const { t } = useCatalogueTranslation();
  const controls = useSelectionControls();
  const [open, setOpen] = useState(false);
  if (!visible) return null;
  const favoriteState = selectionFavoriteState(cards);
  const command = (id, children, variant) => {
    const action = actions.find(item => item.id === id);
    return action && <SelectionAction action={action} onAction={onAction} variant={variant}>{children}</SelectionAction>;
  };
  return <div className="catalogue-selection-floating" role="group" aria-label={t('catalogue:fiche.panel.selected', { count: cards.length })}>
    <span>{t('catalogue:selection.inline.selected', { count: cards.length })}</span>
    <Button variant="icon" size="sm" onClick={onClear} aria-label={t('catalogue:selection.inline.clear')}><X width={14} height={14} /></Button>
    {actions.find(action => action.id === 'favorite') && <Tooltip text={t(favoriteState.labelKey, { count: cards.length })} wrap><SelectionAction action={actions.find(action => action.id === 'favorite')} onAction={onAction} pressed={favoriteState.pressed}><Star width={16} height={16} />{t('catalogue:selection.inline.favorites')}</SelectionAction></Tooltip>}
    <Button size="sm" disabled={controls.busy} aria-haspopup="menu" onClick={onTags}><Tag width={16} height={16} />{t('catalogue:selection.inline.tagsMenu')}</Button>
    <MenuPopover open={open} onOpenChange={setOpen} activation="click" label={t('catalogue:data.bulk.title')} trigger={() => <Button size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><CircleDashed width={16} height={16} />{t('catalogue:selection.inline.metadataMenu')}</Button>}>
      <div className="catalogue-selection-menu-body" data-catalogue-menu="true" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); event.currentTarget.closest('.project-menu-wrap')?.querySelector('button')?.focus(); } else if (event.target.matches?.('select, input')) event.stopPropagation(); }}><SelectionMetadataControls cards={cards} {...controls} /></div>
    </MenuPopover>
    {command('luniiSend', <><Send width={16} height={16} />{t('catalogue:lunii.sendSelection')}</>)}
    {command('assemble', <><Layers width={16} height={16} />{t('catalogue:selection.inline.assemble', { count: cards.length })}</>, 'primary')}
  </div>;
}
