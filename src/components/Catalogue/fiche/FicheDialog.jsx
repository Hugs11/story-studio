import { LuniiFiche } from '../lunii/LuniiFiche.jsx';
import { useCatalogueIdenticalCopies } from '../../../hooks/useCatalogueIdenticalCopies.js';
import { ExemplarRemoveButton } from './ExemplarRemoveButton.jsx';
import { ExemplarTrashButton } from './ExemplarTrashButton.jsx';
import { ExemplarOpenActions } from './ExemplarOpenActions.jsx';
import { catalogueFilesApi } from '../../../store/catalogue/catalogueFilesApi.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCatalogueCard } from '../../../hooks/useCatalogueCard.js';
import { presentCatalogueError } from '../../../store/catalogue/catalogueApi.js';
import { beforeFicheAbandon } from '../../../store/catalogue/metadataDraft.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { useEscapeKey } from '../../../hooks/useEscapeKey.js';
import { detailsRow } from '../../../store/catalogue/detailsRow.js';
import { FICHE_WIDTH, useCatalogueFicheWidth } from '../../../hooks/useCatalogueFicheWidth.js';
import { FicheEditPanel } from './FicheEditPanel.jsx';
import { exemplarActions } from '../../../store/catalogue/cardActions.js';
import { offlinePresentation } from '../../../store/catalogue/offlinePresentation.js';
import { CompactExemplar } from '../open/CompactExemplar.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { FolderOpen } from '../../icons/LucideLocal.jsx';
import { ficheFields, ficheTags, ficheFooter, editPencil } from './FicheSections.jsx';
import { FicheOverview } from './FicheOverview.jsx';
import { FicheDescription } from './FicheDescription.jsx';
import { FicheSelectionSummary } from './SelectionPanel.jsx';
export { FicheSelectionSummary } from './SelectionPanel.jsx';
import { PanelResizeHandle } from '../../structure/PanelResizeHandle.jsx';

export { FICHE_WIDTH, boundedFicheWidth } from '../../../hooks/useCatalogueFicheWidth.js';

export function FichePanel({ luniiSend, exemplarRequest, onExemplarAction, card, onClose, onSimulate, onEdit, onFavorite, onCopyUuid, dataBusy = false, onTags, onRemoveTag, onFilterTag, onEditField, editing, editor, onAction, onTrashDone, onTrashFailed, onTrashActivity, beforeAction, onOpenLarge, position, onNavigate, navigationBusy }) {
  const { t, cell } = useCatalogueTranslation();
  const { card: detail, archiveRemovals, reload, error: loadError } = useCatalogueCard(card.id, undefined, { inspectArchives: true });
  const row = detailsRow(card);
  return <div className="catalogue-fiche-content">
    <FicheOverview loading={!detail} card={card} age={row.age}
      reload={reload} beforeAction={beforeAction} onClose={onClose} onFavorite={onFavorite} dataBusy={dataBusy} onEdit={onEdit} onSimulate={onSimulate} luniiSend={luniiSend} onEditField={onEditField} editing={editing} editor={editor} onOpenLarge={onOpenLarge} position={position} onNavigate={onNavigate} navigationBusy={navigationBusy} />
    {loadError && <p role="alert">{presentCatalogueError(loadError).message}</p>}
    {offlinePresentation(card)?.reason === 'missing' && <div className="catalogue-fiche-missing" role="status">
      <p>{t('catalogue:offline.missing.notice')}</p>
      <Button id="catalogue-fiche-remove" size="sm" onClick={() => onAction?.('removeFromCatalogue')}>{t('catalogue:actions.removeFromCatalogue.label')}</Button>
    </div>}
    {ficheTags({ t, card, dataBusy, onTags, onFilterTag, onRemoveTag })}
    <FicheDescription text={card.description} pencil={onEditField && editPencil({ t, field: 'description', label: t('catalogue:fiche.edit.field.description'), onEditField })} editor={editing === 'description' ? editor : null} />
    <section><h3 className="catalogue-fiche-section-title catalogue-section-title">{t('catalogue:fiche.modal.information')}</h3>
      {ficheFields({ t, cell, card, detail, row, editing, editor, onEditField })}
    </section>
    <FicheExemplars card={card} archiveRemovals={archiveRemovals} request={exemplarRequest} onAction={onExemplarAction} onEdit={onEdit} onSimulate={onSimulate} beforeAction={beforeAction} onTrashDone={onTrashDone} onTrashFailed={onTrashFailed} onTrashActivity={onTrashActivity} />

    {ficheFooter({ t, cell, card, onCopyUuid })}
  </div>;
}

/** Liste de tri : mêmes actions et disponibilités que le menu de l'exemplaire. */
export function FicheExemplars({ card, archiveRemovals = null, request, onAction, onEdit, onSimulate, beforeAction, onTrashDone, onTrashFailed, onTrashActivity, idPrefix = 'catalogue-fiche' }) {
  const { t } = useCatalogueTranslation();
  // The opened fiche's archive count, once it answers, replaces the catalogue decision.
  const exemplars = useMemo(() => !archiveRemovals ? card.exemplars : card.exemplars.map(exemplar => Object.hasOwn(archiveRemovals, exemplar.id)
    ? { ...exemplar, archiveRemoval: archiveRemovals[exemplar.id] } : exemplar), [card.exemplars, archiveRemovals]);
  const identical = useCatalogueIdenticalCopies(card);
  const list = useRef(null);
  const [expanded, setExpanded] = useState(null);
  const [highlight, setHighlight] = useState(null);
  useEffect(() => {
    if (request?.id !== card.id) return;
    const target = list.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
    setHighlight(request.format);
    const timer = setTimeout(() => setHighlight(null), 1800);
    return () => clearTimeout(timer);
  }, [request, card.id]);
  return <section aria-labelledby={`${idPrefix}-copies-title`}>
    <h3 id={`${idPrefix}-copies-title`} className="catalogue-fiche-copies-heading catalogue-section-title">{t('catalogue:fiche.copies.title')} <span className="catalogue-fiche-copies-count">{card.exemplars.length}</span></h3>
    <ul ref={list} id={`${idPrefix}-copies`} className="catalogue-fiche-copies" tabIndex={-1} aria-labelledby={`${idPrefix}-copies-title`}>
      {exemplars.map(exemplar => <FicheExemplarRow key={exemplar.id} card={card} exemplar={exemplar}
        idPrefix={idPrefix} identicalCopy={identical.includes(exemplar.id)} highlight={highlight} expanded={expanded === exemplar.id} onExpand={setExpanded} onAction={onAction} onEdit={onEdit} onSimulate={onSimulate} beforeAction={beforeAction} onTrashDone={onTrashDone} onTrashFailed={onTrashFailed} onTrashActivity={onTrashActivity} />)}
    </ul>
  </section>;
}

function FicheExemplarRow({ idPrefix, card, exemplar, identicalCopy, highlight, expanded, onExpand, onAction, onEdit, onSimulate, beforeAction, onTrashDone, onTrashFailed, onTrashActivity }) {
  const { t } = useCatalogueTranslation();
  const [busy, setBusy] = useState(false);
  const [projectInUse, setProjectInUse] = useState(exemplar.format === 'project');
  const [finished, setFinished] = useState(false);
  const [removed, setRemoved] = useState(false);
  useEffect(() => {
    if (exemplar.format !== 'project') return;
    let alive = true;
    const check = () => catalogueFilesApi.projectAccess('status', exemplar.path).then(result => { if (alive) setProjectInUse(result.inUse); }).catch(() => {});
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    void check();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', visible); };
  }, [exemplar.format, exemplar.path]);
  const actions = exemplarActions(card, { ...exemplar, projectInUse });
  const reveal = actions.find(action => action.id === 'reveal');
  const trash = actions.find(action => action.id === 'trash');
  const lost = exemplar.state === 'missing';
  if (removed) return null;
  return <li id={`${idPrefix}-copy-${exemplar.id}`} tabIndex={0} aria-disabled={busy || undefined} aria-busy={busy || undefined}
    className={`catalogue-fiche-exemplar-row ${highlight === exemplar.format ? 'catalogue-fiche-copy--highlight' : ''} ${finished ? 'catalogue-fiche-copy--removed' : ''}`}>
    <span className="catalogue-fiche-copy-identity"><CompactExemplar exemplar={exemplar} identicalCopy={identicalCopy} showState showName /></span>
    <div className="catalogue-fiche-copy-actions">
      <ExemplarOpenActions idPrefix={idPrefix} card={card} exemplar={exemplar} busy={busy} beforeAction={beforeAction} onEdit={onEdit} onSimulate={onSimulate} />
      {lost && card.exemplars.length > 1 && <ExemplarRemoveButton idPrefix={idPrefix} card={card} exemplar={exemplar} onBusy={value => { setBusy(value); onTrashActivity?.(value); }}
        onDone={() => { setRemoved(true); onTrashDone?.({ key: 'catalogue:fiche.copies.remove.done' }); }} />}
      {!lost && reveal.enabled && <Tooltip text={t('catalogue:actions.reveal.label')} asChild wrap><Button id={`${idPrefix}-copy-${exemplar.id}-reveal`} variant="icon" size="sm" disabled={busy}
        aria-label={t('catalogue:actions.reveal.label')} onClick={event => { event.stopPropagation(); onAction?.(exemplar, reveal, event.currentTarget); }}><FolderOpen width={16} height={16} /></Button></Tooltip>}
      {!lost && (exemplar.member || trash.enabled) && <ExemplarTrashButton idPrefix={idPrefix} card={card} exemplar={exemplar} expanded={expanded} onExpand={onExpand} onBusy={(value, fading) => { setBusy(value); setFinished(fading); onTrashActivity?.(value); }}
        onDone={notice => { setFinished(true); onTrashDone?.(notice); }} onFailed={error => onTrashFailed?.(error)} />}
    </div>
  </li>;
}

/** Nonmodal inspector with a protected inline draft. */
export function FicheDialog({ lunii, onWidthChange, reservedWidth = 0, abandonGuard, card, selectedCards = [], tags, onClose, onTags, actions = [], onSelectionAction, onNavigate, ...props }) {
  const { t } = useCatalogueTranslation();
  const localAbandon = useRef(null);
  const abandon = abandonGuard ?? localAbandon;
  const [editing, setEditing] = useState(null);
  const editTrigger = useRef(null);
  const navigating = useRef(false);
  const navigate = async delta => {
    if (navigating.current || props.navigationBusy) return;
    navigating.current = true;
    try { await beforeFicheAbandon(abandon, () => onNavigate?.(delta)); }
    finally { navigating.current = false; }
  };
  const width = useCatalogueFicheWidth(Boolean(card), onWidthChange, reservedWidth);
  const closeEdit = () => { setEditing(null); requestAnimationFrame(() => document.getElementById(editTrigger.current)?.focus()); };
  useEscapeKey(Boolean(card), () => { if (editing) closeEdit(); else onClose(); });
  if (!card) return null;
  return <aside id="catalogue-fiche-panel" ref={width.panelRef} className="catalogue-fiche" aria-labelledby="catalogue-fiche-title" style={{ width: width.value, maxWidth: `min(100%, ${width.max}px)` }}>
    <PanelResizeHandle ariaLabel={t('catalogue:fiche.panel.resize')} panelClass=".catalogue-fiche" direction={-1} minWidth={width.min} maxWidth={width.max} value={width.value} defaultValue={FICHE_WIDTH.initial}
      onResize={width.onResize} />
    {lunii ? <LuniiFiche {...lunii} onClose={onClose} onNavigate={onNavigate} /> : selectedCards.length > 1 ? <FicheSelectionSummary cards={selectedCards} tags={tags} onClose={onClose} onTags={onTags} actions={actions} onAction={onSelectionAction} />
      : <FichePanel card={card} onClose={onClose} {...props} onNavigate={navigate} onTags={onTags} editing={editing} beforeAction={async () => { if (!editing) return true; if (await abandon.current?.()) { setEditing(null); return true; } return false; }}
        onEditField={(field, trigger) => { void beforeFicheAbandon(abandon, () => { editTrigger.current = trigger.id; setEditing(field); }); }}
        editor={<FicheEditPanel key={`${card.id}:${editing}`} ficheId={card.id} field={editing} onBeforeAbandon={abandon} onCancel={closeEdit} onDone={() => { setEditing(null); requestAnimationFrame(() => document.getElementById(editTrigger.current)?.focus()); }} />} />}

  </aside>;
}
