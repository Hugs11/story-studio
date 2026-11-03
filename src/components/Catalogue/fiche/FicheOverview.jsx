import { missingValue } from '../MissingValue.jsx';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { editableField, ficheOpenActions } from './FicheSections.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { ArrowUp, ArrowDown, Maximize2, X } from '../../icons/LucideLocal.jsx';
import { FavoriteStar } from '../FavoriteStar.jsx';
import { CoverImage } from '../views/CoverImage.jsx';
import { latestExemplarFigures } from '../../../store/catalogue/ficheSummary.js';
import { CoverPencil } from './CoverPencil.jsx';
import { LuniiSendFiche } from '../lunii/LuniiSendFiche.jsx';

/** Presentation and primary actions stay together at every inspector width. */
export function FicheOverview({ card, age, reload, beforeAction, onClose, onFavorite, dataBusy, onEdit, onSimulate, luniiSend, onEditField, editing, editor, onOpenLarge, position, onNavigate, navigationBusy, loading = false }) {
  const { t, cell } = useCatalogueTranslation();
  const meta = latestExemplarFigures(card).map(cell);
  const editable = (field, content, label) => editableField({ t, field, label, content, editing, editor, onEditField });
  return <>
    <header className="catalogue-fiche-titlebar">
      <div className="catalogue-fiche-navigation">
        <Tooltip text={t('catalogue:fiche.modal.previous')} asChild wrap><Button id="catalogue-fiche-previous" variant="icon" size="sm" disabled={!position?.previous || navigationBusy} aria-label={t('catalogue:fiche.modal.previous')} onClick={() => onNavigate?.(-1)}><ArrowUp width={16} height={16} /></Button></Tooltip>
        <Tooltip text={t('catalogue:fiche.modal.next')} asChild wrap><Button id="catalogue-fiche-next" variant="icon" size="sm" disabled={!position?.next || navigationBusy} aria-label={t('catalogue:fiche.modal.next')} onClick={() => onNavigate?.(1)}><ArrowDown width={16} height={16} /></Button></Tooltip>
        {position?.index != null && <span className="catalogue-fiche-position">{t('catalogue:fiche.modal.position', { index: position.index, total: position.total })}</span>}
      </div>
      {onFavorite && <FavoriteStar favorite={card.favorite} busy={dataBusy} onChange={onFavorite} />}
      {onOpenLarge && <Tooltip text={t('catalogue:fiche.modal.open')} asChild wrap><Button id="catalogue-fiche-open-large" variant="icon" size="sm" aria-label={t('catalogue:fiche.modal.open')} onClick={onOpenLarge}><Maximize2 width={16} height={16} /></Button></Tooltip>}
      <Button variant="icon" size="sm" aria-label={t('catalogue:fiche.close.label')} onClick={onClose}><X width={16} height={16} /></Button>
    </header>
    <section className="catalogue-fiche-overview">
      <div className="catalogue-fiche-cover"><CoverImage ficheId={card.id} coverSignature={card.coverSignature} /><CoverPencil reload={reload} onBeforeAction={beforeAction} /></div>
      <div className="catalogue-fiche-intro">
        <div className="catalogue-fiche-heading catalogue-fiche-editable" id="catalogue-fiche-title" tabIndex={-1}>
          {editable('title', <h2>{card.displayTitle ?? card.title ?? t('catalogue:card.untitled')}</h2>, t('catalogue:fiche.edit.field.title'))}
        </div>
        {!loading && <dl className="catalogue-fiche-age"><div><dt className="catalogue-visually-hidden">{t('catalogue:fiche.inline.age')}</dt>
          <dd className="catalogue-fiche-editable">{editable('age', age.kind === 'missing' ? missingValue(t) : cell(age), t('catalogue:fiche.inline.age'))}</dd>
        </div></dl>}
        {!loading && meta.length > 0 && <p className="catalogue-fiche-summary">{meta.join(' · ')}</p>}
      </div>
    </section>
    {ficheOpenActions({ t, card, onEdit, onSimulate })}
    {luniiSend && <LuniiSendFiche card={card} state={luniiSend.state} onSend={luniiSend.onSend} onSee={luniiSend.onSee} />}
  </>;
}
