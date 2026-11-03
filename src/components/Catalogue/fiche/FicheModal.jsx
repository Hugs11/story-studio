import { missingValue } from '../MissingValue.jsx';
import { latestExemplarFigures } from '../../../store/catalogue/ficheSummary.js';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useCatalogueCard } from '../../../hooks/useCatalogueCard.js';
import { useEscapeKey } from '../../../hooks/useEscapeKey.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { beforeFicheAbandon } from '../../../store/catalogue/metadataDraft.js';
import { detailsRow } from '../../../store/catalogue/detailsRow.js';
import { ficheModalKeyStep, modalEscapeStep } from '../../../store/catalogue/ficheModal.js';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { ChevronLeft, ChevronRight, X } from '../../icons/LucideLocal.jsx';
import { FavoriteStar } from '../FavoriteStar.jsx';
import { CoverImage } from '../views/CoverImage.jsx';
import { CoverPencil } from './CoverPencil.jsx';
import { FicheEditPanel } from './FicheEditPanel.jsx';
import { FicheDescription } from './FicheDescription.jsx';
import { FicheExemplars } from './FicheDialog.jsx';
import { ficheFields, ficheTags, ficheFooter, editableField, editPencil, ficheOpenActions } from './FicheSections.jsx';
import './FicheModal.css';

const PREFIX = 'catalogue-fiche-modal';
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Grande fiche en fenêtre modale : même contenu que le panneau latéral, avec
 * le tableau des exemplaires et toutes leurs actions. Les dialogues
 * secondaires (étiquettes, corbeille, choix d'exemplaire, menus) s'ouvrent
 * au-dessus et gardent leur Échap ; Simuler et Ouvrir dans l'éditeur la
 * ferment avant de lancer l'action.
 */
export function FicheModal({ card, position, onStep, onClose, onSimulate, onEdit, onTrashActivity, ...props }) {
  const { t, cell } = useCatalogueTranslation();
  const { card: detail, archiveRemovals, reload, error: loadError } = useCatalogueCard(card.id, undefined, { inspectArchives: true });
  const row = detailsRow(card);
  const abandon = useRef(null);
  const dialog = useRef(null);
  const title = useRef(null);
  const pressedOnBackdrop = useRef(false);
  const editTrigger = useRef(null);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const canStep = !busy && position?.index != null;

  const guarded = action => { if (!busyRef.current) void beforeFicheAbandon(abandon, action); };
  const closeEdit = () => { setEditing(null); requestAnimationFrame(() => document.getElementById(editTrigger.current)?.focus()); };
  const requestClose = () => guarded(onClose);
  const requestStep = delta => guarded(() => onStep(delta));
  const beforeAction = async () => { if (!editing) return true; if (await abandon.current?.()) { setEditing(null); return true; } return false; };
  // Simuler et Ouvrir dans l'éditeur quittent la fiche avant de lancer l'action.
  const leaveThen = run => (command, trigger) => guarded(() => { onClose({ restoreFocus: false }); run?.(command, trigger); });

  useEscapeKey(true, () => {
    const step = modalEscapeStep({ busy: busyRef.current, editing: Boolean(editing) });
    if (step === 'closeEdit') closeEdit(); else if (step === 'close') requestClose();
  });

  useEffect(() => { title.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKeyDown = event => {
      const inside = dialog.current?.contains(event.target) || event.target === document.body;
      const delta = inside ? ficheModalKeyStep(event) : 0;
      if (!delta || !canStep) return;
      const target = delta < 0 ? position.previous : position.next;
      if (!target) return;
      event.preventDefault();
      requestStep(delta);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const trapFocus = event => {
    if (event.key !== 'Tab') return;
    const items = [...dialog.current.querySelectorAll(FOCUSABLE)].filter(element => element.getClientRects().length > 0);
    if (!items.length) { event.preventDefault(); title.current?.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && (event.target === first || event.target === title.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && event.target === last) { event.preventDefault(); first.focus(); }
  };

  const age = row.age;
  const editor = <FicheEditPanel key={`${card.id}:${editing}`} ficheId={card.id} field={editing} onBeforeAbandon={abandon} onCancel={closeEdit} onDone={closeEdit} />;
  const onEditField = (field, trigger) => { void beforeFicheAbandon(abandon, () => { editTrigger.current = trigger.id; setEditing(field); }); };
  const editable = (field, content, label) => editableField({ t, idPrefix: PREFIX, field, label, content, editing, editor, onEditField });
  const meta = latestExemplarFigures(card);
  const {
    onFavorite, dataBusy, onTags, onRemoveTag, onFilterTag, onCopyUuid, onExemplarAction, onTrashDone, onTrashFailed,
  } = props;

  return <div className="catalogue-fiche-modal-overlay" onMouseDown={event => { pressedOnBackdrop.current = event.target === event.currentTarget; }}
    onClick={event => { if (event.target === event.currentTarget && pressedOnBackdrop.current) requestClose(); }}>
    <div ref={dialog} className="catalogue-fiche-modal" role="dialog" aria-modal="true" aria-labelledby={`${PREFIX}-title`} onKeyDown={trapFocus}>
      <div className="catalogue-fiche-modal-panel">
        <header className="catalogue-fiche-modal-header">
          {position?.index != null && <span className="catalogue-fiche-modal-position">{t('catalogue:fiche.modal.position', { index: position.index, total: position.total })}</span>}
          <span className="catalogue-fiche-modal-spacer" />
          {onFavorite && <FavoriteStar favorite={card.favorite} busy={dataBusy} onChange={onFavorite} />}
          <span className="catalogue-fiche-modal-separator" aria-hidden="true" />
          <Tooltip text={t('catalogue:fiche.modal.close')} asChild wrap><Button id={`${PREFIX}-close`} variant="icon" size="sm" aria-label={t('catalogue:fiche.modal.close')} onClick={requestClose}><X width={16} height={16} /></Button></Tooltip>
        </header>
        <div className="catalogue-fiche catalogue-fiche-modal-body">
          <div className="catalogue-fiche-modal-grid">
            <aside className="catalogue-fiche-modal-side">
              <div className="catalogue-fiche-cover"><CoverImage ficheId={card.id} coverSignature={card.coverSignature} /><CoverPencil idPrefix={PREFIX} reload={reload} onBeforeAction={beforeAction} /></div>
              {ficheOpenActions({ t, idPrefix: PREFIX, card, onEdit: onEdit && leaveThen(onEdit), onSimulate: onSimulate && leaveThen(onSimulate) })}
              <h3 className="catalogue-fiche-modal-section-title catalogue-section-title">{t('catalogue:fiche.modal.information')}</h3>
              {ficheFields({ t, cell, card, detail, row, editing, editor, onEditField, idPrefix: PREFIX })}
            </aside>
            <div className="catalogue-fiche-modal-main">
              <div className="catalogue-fiche-heading catalogue-fiche-editable">
                {editable('title', <h2 id={`${PREFIX}-title`} ref={title} tabIndex={-1} className="catalogue-fiche-modal-title">{card.displayTitle ?? card.title ?? t('catalogue:card.untitled')}</h2>, t('catalogue:fiche.edit.field.title'))}
              </div>
              {editing === 'title' && <span id={`${PREFIX}-title`} ref={title} tabIndex={-1} className="catalogue-visually-hidden">{card.displayTitle ?? card.title ?? t('catalogue:card.untitled')}</span>}
              {detail && <div className="catalogue-fiche-modal-meta">
                <dl className="catalogue-fiche-age"><div><dt className="catalogue-visually-hidden">{t('catalogue:fiche.inline.age')}</dt>
                  <dd className="catalogue-fiche-editable">{editable('age', age.kind === 'missing' ? missingValue(t) : cell(age), t('catalogue:fiche.inline.age'))}</dd>
                </div></dl>
                {meta.length > 0 && <span className="catalogue-fiche-modal-summary">{meta.map(item => cell(item)).join(' · ')}</span>}
              </div>}
              {loadError && <p role="alert">{presentCatalogueError(loadError).message}</p>}
              <FicheDescription text={card.description} full pencil={editPencil({ t, idPrefix: PREFIX, field: 'description', label: t('catalogue:fiche.edit.field.description'), onEditField })} editor={editing === 'description' ? editor : null} />
              {ficheTags({ t, card, dataBusy, onTags, onFilterTag, onRemoveTag })}
              <FicheExemplars idPrefix={PREFIX} card={card} archiveRemovals={archiveRemovals} onAction={onExemplarAction} onEdit={onEdit && leaveThen(onEdit)} onSimulate={onSimulate && leaveThen(onSimulate)}
                beforeAction={beforeAction} onTrashDone={onTrashDone} onTrashFailed={onTrashFailed} onTrashActivity={value => { setBusy(value); onTrashActivity?.(value); }} />
              {ficheFooter({ t, cell, card, onCopyUuid })}
            </div>
          </div>
        </div>
      </div>
      {canStep && position.previous && <Tooltip text={t('catalogue:fiche.modal.previous')} asChild wrap><Button variant="icon" className="catalogue-fiche-modal-arrow catalogue-fiche-modal-arrow--previous"
        aria-label={t('catalogue:fiche.modal.previous')} onClick={() => requestStep(-1)}><ChevronLeft width={20} height={20} /></Button></Tooltip>}
      {canStep && position.next && <Tooltip text={t('catalogue:fiche.modal.next')} asChild wrap><Button variant="icon" className="catalogue-fiche-modal-arrow catalogue-fiche-modal-arrow--next"
        aria-label={t('catalogue:fiche.modal.next')} onClick={() => requestStep(1)}><ChevronRight width={20} height={20} /></Button></Tooltip>}
    </div>
    <p className="catalogue-fiche-modal-help"><Trans i18nKey="catalogue:fiche.modal.help" components={{ key: <kbd className="kbd kbd--hint kbd--overlay" /> }} /></p>
  </div>;
}
