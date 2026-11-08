import { queuedMarks } from '../../store/catalogue/luniiQueueView.js';
import { useLuniiPanelWidth } from '../../hooks/useLuniiPanelWidth.js';
import { useCatalogueSendUi } from '../../hooks/useCatalogueSendUi.js';
import { useLuniiDnd } from '../../hooks/useLuniiDnd.js';
import { LuniiDndFrame } from './lunii/LuniiDndFrame.jsx';
import { luniiRows } from '../../store/catalogue/luniiDevices.js';
import { tagPopoverAt } from '../../store/catalogue/tagPopover.js';
import { FileExemplarChoice } from './open/FileExemplarChoice.jsx';
import { exemplarActions } from '../../store/catalogue/cardActions.js';
import { catalogueCardActivation } from '../../store/catalogue/cardActivation.js';
import { CatalogueAssembly } from './assembly/CatalogueAssembly.jsx';
import { useCatalogueAssembly } from '../../hooks/useCatalogueAssembly.js';
import { assemblySelection, assemblyAction, assemblyMenuEntries } from '../../store/catalogue/assemblySelection.js';
import { DuplicateDialog } from './files/DuplicateResults.jsx';
import { CheckerEntry } from './files/CheckerEntry.jsx';
import { beforeFicheAbandon } from '../../store/catalogue/metadataDraft.js';
import { useCatalogueUndo } from '../../hooks/useCatalogueUndo.js';
import { useCatalogueRemoval } from '../../hooks/useCatalogueRemoval.js';
import { SelectionControlsContext } from './selection/SelectionControls.jsx';
import { showSelectionBar } from '../../store/catalogue/selectionPresentation.js';
import { SelectionFloatingBar } from './fiche/SelectionPanel.jsx';
import { UndoNotice } from './UndoNotice.jsx';
import { currentCatalogueCards } from '../../store/catalogue/entryModel.js';
import { useCatalogueTags } from '../../hooks/useCatalogueTags.js';
import { useCatalogueSelectionActions } from '../../hooks/useCatalogueSelectionActions.js';
import { useCatalogueFavoriteOverrides } from '../../hooks/useCatalogueFavoriteOverrides.js';
import { applyFavoriteOverrides } from '../../store/catalogue/favoriteOverrides.js';
import { stableCardView } from '../../store/catalogue/cardRenderMemo.js';
import { CatalogueStatusBar } from './CatalogueStatusBar.jsx';
import { TagSubmenu } from './tags/TagSubmenu.jsx';
import { useCatalogueReturn } from '../../hooks/useCatalogueReturn.js';
import { browseSession } from '../../store/catalogue/browseSession.js';
import { useCatalogueOpen } from '../../hooks/useCatalogueOpen.js';
import { focusCatalogueSearch } from '../../store/catalogue/searchFocus.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import i18next from 'i18next';
import { useCatalogueWindow } from '../../hooks/useCatalogueWindow.js';
import { useCatalogueView } from '../../hooks/useCatalogueView.js';
import { useCatalogueSelection } from '../../hooks/useCatalogueSelection.js';
import { useCatalogueMenus } from '../../hooks/useCatalogueMenus.js';
import { useCatalogueActions } from '../../hooks/useCatalogueActions.js';
import { useCatalogueShortcuts } from '../../hooks/useCatalogueShortcuts.js';
import { useCatalogueOpenSimulation } from '../../hooks/useCatalogueOpenSimulation.js';
import { catalogueOpenApi } from '../../store/catalogue/catalogueOpenApi.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { cardMenuActions, menuEntries } from '../../store/catalogue/cardActions.js';
import { columnsFromTops, navigateKey } from '../../store/catalogue/listNavigation.js';
import { captureMenuTarget, closeFicheState, reconcileFicheState, selectionPanelTarget } from '../../store/catalogue/browserState.js';
import { domId } from '../../store/catalogue/viewModes.js';
import { CardGridView } from './views/CardGridView.jsx';
import { ListView } from './views/ListView.jsx';
import { CardContextMenu } from './menus/CardContextMenu.jsx';
import { CatalogueMenuLayer } from './menus/CatalogueMenu.jsx';
import { FicheDialog } from './fiche/FicheDialog.jsx';
import { CatalogueFicheModal } from './fiche/CatalogueFicheModal.jsx';
import { ficheActionHandlers } from '../../store/catalogue/ficheActionHandlers.js';
import { useCatalogueFicheModal } from '../../hooks/useCatalogueFicheModal.js';
import { ficheModalPosition, escapeStep } from '../../store/catalogue/ficheModal.js';
import { ExemplarChoiceDialog } from './open/ExemplarChoiceDialog.jsx';
import { CatalogueSimulator } from './open/CatalogueSimulator.jsx';
import './CatalogueViews.css';
// Keep toolbar overrides after views and their component styles.
import { CatalogueToolbar } from './CatalogueToolbar.jsx';

const VIEWS = Object.freeze({ cards: CardGridView, list: ListView });

/**
 * Consultation du catalogue : barre d'outils, vue active (Catalogue, Liste,
 * Détails, toutes alimentées par le même résultat), menus, fiche complète.
 * Les annonces et les erreurs remontent à l'écran, qui possède la seule
 * région `aria-live`.
 */
export function CatalogueBrowser({ abandonGuard, lunii, sendBridge, renderLunii, onLandAggregate, onAssemblyLanded, cards: allCards, revision, active = true, api, openApi = catalogueOpenApi(), onAnnounce, onError, onOpenEditor, onWarning, onRefresh, onFavoritePatch, ready = true, renderHeader, renderEmpty, sources = [], appVersion = '' }) {
  const favoriteOverrides = useCatalogueFavoriteOverrides(allCards, revision);
  const cards = useMemo(() => applyFavoriteOverrides(currentCatalogueCards(allCards), favoriteOverrides.overrides), [allCards, favoriteOverrides.overrides]);
  const tags = useCatalogueTags();
  useEffect(() => { void tags.reload(); }, [revision, tags.reload]);
  const undo = useCatalogueUndo(revision, onError);
  const removeOffline = useCatalogueRemoval({ onRemoved: onRefresh, onAnnounce, onError });
  const [tagPopover, setTagPopover] = useState(null);
  useMessageLanguage();
  const language = i18next.resolvedLanguage ?? 'fr';
  const view = useCatalogueView(cards, { language });
  const order = useMemo(() => view.items.map((item) => item.card.id), [view.items]);
  const selection = useCatalogueSelection(order, cards, ready, lunii);
  const assembly = useCatalogueAssembly();
  const data = useCatalogueSelectionActions({ ids: selection.ids, cards, visibleIds: order, revision, onAnnounce, onError, onOutcome: undo.remember, onFailure: undo.fail,
    onReload: async () => { await Promise.all([onRefresh?.(), tags.reload()]); },
    optimistic: favoriteOverrides, applyLocal: (mutation, outcome) => mutation.kind === 'setFavorite' && onFavoritePatch?.({ ids: outcome.affectedCardIds, value: mutation.value, revision: outcome.catalogueRevision }) === true });
  useEffect(() => { const error = tags.error; if (error) onError(error); }, [tags.error, onError]);
  const menus = useCatalogueMenus();
  const actions = useCatalogueActions({ api, onAnnounce, onError });
  const localAbandon = useRef(null);
  const ficheAbandon = abandonGuard ?? localAbandon;
  const assemblyReturnFocus = useRef(null);
  const startAssembly = (trigger = document.activeElement) => beforeFicheAbandon(ficheAbandon, () => {
    assemblyReturnFocus.current = { trigger };
    return assembly.start(assemblySelection(selection.ids, view.items.map(item => item.card)));
  });
  const lastClick = useRef(null);
  const actionFocus = useRef(null);
  const restoreActionFocus = useCallback(() => requestAnimationFrame(() => {
    const trigger = actionFocus.current;
    const fallback = document.getElementById(trigger?.id) ?? document.getElementById('catalogue-fiche-copies') ?? document.getElementById('catalogue-fiche-location');
    (trigger?.isConnected ? trigger : fallback)?.focus();
    if (!trigger?.isConnected) actionFocus.current = null;
  }), []);
  const [exemplarRequest, setExemplarRequest] = useState(null);
  const [ficheId, setFicheId] = useState(() => browseSession.restore()?.ficheId ?? null);
  const [expanded, setExpanded] = useState(() => new Set(browseSession.restore()?.expanded ?? []));
  const menuItem = useRef(null);
  const containerRef = useRef(null);
  const searchRef = useRef(null);
  const focusedItem = useRef(null);
  const lastFocusedCard = useRef(browseSession.restore()?.focusedCardId ?? null);
  const [focusedCardId, setFocusedCardId] = useState(() => browseSession.restore()?.focusedCardId ?? null);
  const browserActive = useRef(active);
  browserActive.current = active;
  const keyboardMove = useRef(false);
  const panelNavigation = useRef(false);
  const scrollPositions = useRef(browseSession.restore()?.scroll ?? {});
  const window = useCatalogueWindow(view.items, view.view, selection.activeId, expanded, keyboardMove, focusedCardId, scrollPositions, view.density);
  const cardsById = useMemo(() => new Map(cards.map((card) => [card.id, card])), [cards]);
  const [trashCard, setTrashCard] = useState(null);
  const ficheCard = trashCard ?? (ficheId ? (data.targets.length === 1 ? data.targets[0] : cardsById.get(ficheId)) ?? null : null);
  const simulation = useCatalogueOpenSimulation({ api: openApi, active, cardsById, revision, ficheId, setFicheId, menus, onError });

  const editor = useCatalogueOpen({ api: openApi, cardsById, revision, onOpen: onOpenEditor, onWarning, onError, onRefresh });
  const sendUi = useCatalogueSendUi({ lunii, targets: data.targets });

  useCatalogueReturn({ view: view.view, sort: view.sort, filterState: view.filterState, selection: selection.snapshot, activeId: selection.activeId, ficheId, expanded: [...expanded], focusedCardId: lastFocusedCard.current, scroll: scrollPositions.current }, {
    ready, order,
    onRestore: saved => {
      if (saved.filterState) view.dispatch({ type: 'restore', value: saved.filterState });
      selection.restore(saved.selection, saved.activeId);
      setExpanded(new Set(saved.expanded ?? []));
      setFicheId(cardsById.has(saved.ficheId) ? saved.ficheId : null);
      setFocusedCardId(saved.focusedCardId);
      lastFocusedCard.current = saved.focusedCardId;
      requestAnimationFrame(() => {
        if (saved.focusToolbar) searchRef.current?.focus();
        else if (saved.focusedCardId) document.getElementById(domId('catalogue-item',saved.focusedCardId))?.focus({ preventScroll: true });
      });
    },
  });

  // Le focus ne suit la fiche active que lorsqu'elle a été changée au
  // clavier : une actualisation ne le déplace jamais.
  useEffect(() => {
    if (!keyboardMove.current || !selection.activeId) return;
    keyboardMove.current = false;
    // La navigation des fiches garde le focus dans le panneau ou la modale.
    if (panelNavigation.current) { panelNavigation.current = false; return; }
    if (ficheModal.modal) return;
    document.getElementById(domId('catalogue-item', selection.activeId))?.focus();
  }, [selection.activeId]);

  useEffect(() => {
    const focused = focusedItem.current;
    if (browserActive.current && focused && !focused.element.isConnected) {
      const target = document.getElementById(focused.id) ?? document.getElementById(domId('catalogue-item', selection.activeId));
      target?.focus({ preventScroll: true });
    }
  }, [view.items, selection.activeId]);

  const openFiche = useCallback((id, { selecting = false } = {}) => {
    if (id !== null) lastFocusedCard.current = id;
    // Laisser la grille accessible pendant la construction d'une sélection en fenêtre étroite.
    const keepClosed = selecting && globalThis.matchMedia?.('(max-width: 900px)')?.matches;
    setFicheId(current => id === null || (keepClosed && current === null) ? null : id);
  }, []);
  const restoreFicheFocus = useCallback((id) => {
    requestAnimationFrame(() => {
      if (!browserActive.current) return;
      const target = (id === null ? null : document.getElementById(domId('catalogue-item', id)))
        ?? searchRef.current;
      target?.focus({ preventScroll: true });
    });
  }, []);
  const ficheModal = useCatalogueFicheModal({ order, cardsById, ready, selection, keyboardMove, setFicheId, restoreFocus: restoreFicheFocus, lastViewed: lastFocusedCard, panelNavigation });
  useEffect(() => { if (!active && ficheModal.modal) ficheModal.close({ restoreFocus: false }); }, [active, ficheModal.modal, ficheModal.close]);
  const closeFiche = useCallback(({ clearSelection = false } = {}) => {
    void beforeFicheAbandon(ficheAbandon, () => {
      if (clearSelection) selection.clear();
      const transition = closeFicheState(ficheId, order, selection.activeId);
      setFicheId(transition.ficheId);
      restoreFicheFocus(transition.focusId);
    });
  }, [ficheId, order, selection, restoreFicheFocus]);

  useEffect(() => {
    if (!ready || trashCard) return;
    const transition = reconcileFicheState(ficheId, cardsById, order, selection.activeId);
    if (!transition) return;
    setFicheId(data.targets[0]?.id ?? transition.ficheId);
    // Un menu issu de la fiche retirée ne survit pas à sa fermeture.
    menus.dispatch({ type: 'close', restoreFocus: false });
    restoreFicheFocus(transition.focusId);
  }, [ficheId, cardsById, order, selection.activeId, menus.dispatch, restoreFicheFocus, ready, trashCard, data.targets]);

  const previousSelectionCount = useRef(data.targets.length);
  useEffect(() => {
    const wasMultiple = previousSelectionCount.current > 1;
    previousSelectionCount.current = data.targets.length;
    if (wasMultiple && !data.targets.length && !trashCard) setFicheId(null);
  }, [data.targets.length, trashCard]);

  const openMenu = (item, kind, scope, { trigger, point = null }) => {
    lastFocusedCard.current = item.card.id;
    menuItem.current = captureMenuTarget(item, revision);
    const probe = { open: true, kind, scope, step: null };
    menus.open({ kind, targetId: item.card.id, scope, trigger, point, itemCount: sendUi.menuEntries(assemblyMenuEntries(menuEntries(probe, item.card, item.exemplars), probe, data.targets.length, assembly.state.phase), probe, item.card).length });
  };

  const columns = () => {
    if (view.view !== 'cards' || !containerRef.current) return 1;
    if (window) return window.columns;
    return columnsFromTops([...containerRef.current.children].map((element) => element.offsetTop));
  };

  const device = lunii?.luniiDevices.find(d => d.id === lunii.activeLuniiId);
  const deviceRows = luniiRows(device).map(story => { const card = cardsById.get(story.catalogueFicheId); return { ...story, author: card?.author, age: card?.age }; });
  const luniiStory = lunii?.selection.side === 'lunii' ? deviceRows.find(s => s.key === lunii.selection.ids[0]) : null;
  const luniiPanelWidth = useLuniiPanelWidth(lunii?.luniiPanelWidth ?? 330, Boolean(device) && !lunii.luniiPanelCollapsed, Boolean(luniiStory || (lunii?.selection.side !== 'lunii' && view.fichePanelVisible && ficheCard)));
  const luniiWidth = device ? lunii.luniiPanelCollapsed ? 48 : luniiPanelWidth.value : 0;
  const onLuniiSelect = ids => beforeFicheAbandon(ficheAbandon, () => { setFicheId(null); lunii.store.select('lunii', Array.isArray(ids) ? ids : [ids]); });
  const onLuniiDeviceChange = id => beforeFicheAbandon(ficheAbandon, () => lunii.store.selectDevice(id));
  const dnd = useLuniiDnd({ lunii, sendUi, onDeviceChange: onLuniiDeviceChange });
  const viewProps = {
    luniiSend: sendUi.available ? sendUi : null,
    luniiFicheIds: new Set(deviceRows.filter(s => !s.orphan).map(s => s.catalogueFicheId).filter(Boolean)),
    density: view.density,
    listColumns: view.listColumns,
    sort: view.sort,
    setSortKey: view.setSortKey,
    toggleDirection: view.toggleDirection,
    window,
    dataBusy: data.busy,
    onFavorite: card => data.favorite([card]),
    onFilterAge: age => view.dispatch({ type: 'set', family: 'age', value: { min: age, max: age, hideUnknown: false } }),
    onFilterTag: id => view.dispatch({ type: 'set', family: 'tags', value: { ids: [id], mode: 'any' } }),
    activeId: selection.activeId,
    selected: selection.selected,
    expanded,
    menu: menus.menu,
    containerRef,
    setActiveId: selection.setActiveId,
    ...catalogueCardActivation({ selection, order, cardsById, openFiche, abandon: ficheAbandon, simulate: simulation.simulate, edit: editor.edit, revision, focusExemplars: setExemplarRequest, openModal: ficheModal.show, clicks: lastClick }),
    onToggleExpanded: (id) => setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    }),
    onCardMenu: (event, item) => {
      event.preventDefault();
      openMenu(item, 'card', null, { trigger: event.currentTarget, point: event.type === 'keydown' ? null : { x: event.clientX, y: event.clientY } });
    },
    onItemKeyDown: (event, item) => {
      if (event.target !== event.currentTarget) return;
      const result = navigateKey({ activeId: item.card.id, order, columns: columns(), pageRows: window.pageRows }, event);
      if (!result) return;
      event.preventDefault();
      if (result.selection) {
        void beforeFicheAbandon(ficheAbandon, () => {
          openFiche(selectionPanelTarget(selection.snapshot, result.selection, order, result.activeId), { selecting: true });
          selection.apply(result.selection);
        });
      }
      if (result.activeId !== selection.activeId) {
        keyboardMove.current = true;
        selection.setActiveId(result.activeId);
      }
      if (result.command === 'open') void viewProps.onOpenModal(result.activeId);
      if (result.command === 'menu') openMenu(item, 'card', null, { trigger: event.currentTarget });
    },
  };

  // Cards receive stable handlers that call this render's viewProps (cardRenderMemo.js).
  const latestView = useRef(null);
  latestView.current = viewProps;
  const viewDelegates = useRef(new Map());

  // The activity pill opens the editor on a refused story through this bridge.
  useEffect(() => {
    if (sendBridge) sendBridge.current = { openEditor: id => viewProps.onEdit(id, null) };
    return () => { if (sendBridge) sendBridge.current = null; };
  });

  const [duplicateScope, setDuplicateScope] = useState(undefined);
  const [checkerTarget, setCheckerTarget] = useState(null);
  const [fileChoice, setFileChoice] = useState(null);
  useEffect(() => {
    if (actionFocus.current && !actionFocus.current.isConnected) restoreActionFocus();
  }, [cards, restoreActionFocus]);
  const menu = menus.menu;
  const target = menu.open ? menuItem.current : null;
  const entries = target ? sendUi.menuEntries(assemblyMenuEntries(menuEntries(menu, target.card, target.exemplars), menu, data.targets.length, assembly.state.phase), menu, target.card) : [];
  const activate = (entry) => {
    if (!entry || !target) return;
    actionFocus.current = document.getElementById(menu.returnFocusId);
    const { action } = entry;
    const exemplar = entry.exemplar ?? (target.exemplars.length === 1 ? target.exemplars[0] : null);
    if (entry.back) {
      menus.dispatch({ type: 'back', itemCount: cardMenuActions(target.card, target.exemplars).length + 1 });
      return;
    }
    if (!action.enabled) return;
    if (['reveal', 'checkPack'].includes(action.id) && !exemplar && target.exemplars.length > 1) {
      menus.close(false); setFileChoice({ target, action, triggerId: menu.returnFocusId }); return;
    }
    if (action.id === 'removeFromCatalogue') {
      menus.close(false);
      void removeOffline([target.card]);
      return;
    }
    if (action.id === 'luniiSend') {
      menus.close();
      void sendUi.onSend(target.card.id, entry.deviceId);
      return;
    }
    if (action.id === 'assemble') {
      menus.close();
      void startAssembly(document.getElementById(menu.returnFocusId));
      return;
    }
    if (['favorite', 'tags'].includes(action.id)) {
      // Les étiquettes s'ouvrent en cascade depuis l'entrée du menu (CardContextMenu), jamais par `activate`.
      if (action.id === 'tags') return;
      menus.close();
      if (action.id === 'favorite') {
        const current = cardsById.get(target.card.id);
        if (current && order.includes(current.id)) void data.favorite([current]);
      }
      return;
    }
    if (action.id === 'duplicates' || action.id === 'checkPack') {
      menus.close(false);
      void beforeFicheAbandon(ficheAbandon, () => {
        if (action.id === 'duplicates') setDuplicateScope(target.card.id);
        else setCheckerTarget({ card: target.card, exemplar });
      });
      return;
    }
    if (['edit', 'editPack', 'openProject', 'openAndGenerate'].includes(action.id)) {
      menus.close(false); ficheModal.close({ restoreFocus: false });
      void beforeFicheAbandon(ficheAbandon, () => editor.edit({ purpose: action.id === 'openAndGenerate' ? 'editAndGenerate' : 'edit', card: target.card, exemplar, revision: target.revision, returnFocusId: menu.returnFocusId }));
      return;
    }
    if (action.id === 'simulate') {
      menus.close(false); ficheModal.close({ restoreFocus: false });
      void beforeFicheAbandon(ficheAbandon, () => simulation.simulate({ card: target.card, exemplar, revision: target.revision, returnFocusId: menu.returnFocusId }));
      return;
    }
    if (action.choice) {
      menus.dispatch({ type: 'choose', action: action.id, itemCount: target.exemplars.length + 1 });
      return;
    }
    if (action.id === 'openFiche') {
      menus.close(false);
      openFiche(target.card.id);
      return;
    }
    if (['copyUuid', 'copyTitle'].includes(action.id)) return actions.copy(action.id, target.card, exemplar);
    menus.close();
    if (action.id === 'reveal') void actions.reveal(target, exemplar);
  };
  const back = () => menus.dispatch({ type: 'back', itemCount: cardMenuActions(target.card, target.exemplars).length + 1 });

  async function undoLast() {
    if (undo.state.status !== 'ready' || data.busy) return false;
    const result = await data.mutate({ kind: 'undoMutation', undoToken: undo.state.token });
    if (result) undo.done();
    return true;
  }

  useCatalogueShortcuts({
    blocked: () => ficheModal.modal !== null || fileChoice !== null || menus.menu.open || tagPopover !== null || simulation.blocking || editor.choice.state.open,
    undo: undoLast,
    search: () => focusCatalogueSearch(searchRef.current),
    selectAll: () => {
      if (document.activeElement?.closest('.lunii-panel, .lunii-fiche')) return;
      void beforeFicheAbandon(ficheAbandon, () => {
      selection.selectAll();
      if (order.length) openFiche(order.includes(selection.activeId) ? selection.activeId : order[0]);
    }); },
    clear: () => {
      const step = escapeStep({ selectionCount: selection.ids.length, panelOpen: ficheId !== null });
      if (step === 'clearSelection') selection.clear();
      else if (step === 'clearSelectionAndClosePanel') closeFiche({ clearSelection: true });
      else if (step === 'closePanel') closeFiche();
      return step !== null;
    },
  }, { active });

  const panelActions = [...data.actions, assemblyAction(data.targets.length, assembly.state.phase), ...(sendUi.action ? [sendUi.action] : [])];
  const runSelectionAction = id => {
    if (id === 'luniiSend') sendUi.runSelection();
    else if (id === 'assemble') void startAssembly();
    else if (id === 'favorite') void data.favorite();
  };
  const ficheServices = { revision, data, actions, setTagPopover, actionFocus, simulate: simulation.simulate, edit: editor.edit, onFilterTag: viewProps.onFilterTag, onAnnounce, onRefresh, onError };
  const panelHandlers = ficheActionHandlers({ ...ficheServices, card: ficheCard, selectionTargets: true, onTrashSettled: () => setTrashCard(null) });

  const floatingSelectionVisible = showSelectionBar(view.fichePanelVisible, data.targets.length);
  const clearSelection = () => { selection.clear(); restoreFicheFocus(selection.activeId); };
  // Les commandes suivent la révision courante sans renouveler le contexte à chaque rendu.
  const selectionCommands = useRef(null);
  selectionCommands.current = { mutate: data.mutate, clear: clearSelection };
  const selectionControls = useMemo(() => ({ busy: data.busy, error: data.error,
    mutate: (...args) => selectionCommands.current.mutate(...args),
    clear: () => selectionCommands.current.clear(),
  }), [data.busy, data.error]);
  const View = VIEWS[view.view];
  return <LuniiDndFrame dnd={dnd} send={lunii?.send} cardsById={cardsById}><SelectionControlsContext.Provider value={selectionControls}><section className="catalogue-browser" aria-labelledby="catalogue-title">
    <CatalogueToolbar tags={tags.items} view={{ ...view, toggleFichePanel: () => { void beforeFicheAbandon(ficheAbandon, view.toggleFichePanel); } }} cards={cards} sources={sources} searchRef={searchRef} renderChrome={renderHeader ? controls => renderHeader({ view, onDuplicates: () => setDuplicateScope(null), ...controls }) : undefined} />
    <UndoNotice noticeToken={undo.noticeToken} state={undo.state} busy={data.busy} onUndo={undoLast} />
    {duplicateScope !== undefined && <DuplicateDialog ficheId={duplicateScope} cards={cards} onClose={() => { setDuplicateScope(undefined); restoreActionFocus(); }} />}
    {checkerTarget && <CheckerEntry {...checkerTarget} onClose={() => { setCheckerTarget(null); restoreActionFocus(); void onRefresh?.(); }} />}
    {fileChoice && <FileExemplarChoice card={fileChoice.target.card} command={fileChoice.action.id}
      availability={exemplar => exemplarActions(fileChoice.target.card, exemplar).find(item => item.id === fileChoice.action.id) ?? { enabled: false }}
      onClose={() => { const id = fileChoice.triggerId; setFileChoice(null); requestAnimationFrame(() => document.getElementById(id)?.focus()); }}
      onChoose={items => {
        const { target: chosen, action, triggerId } = fileChoice; const exemplar = items[0]; setFileChoice(null);
        if (action.id === 'reveal') void actions.reveal(chosen, exemplar);
        else if (action.id === 'checkPack') setCheckerTarget({ card: chosen.card, exemplar });
        requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
      }} />}
    <CatalogueAssembly assembly={assembly} onLand={onLandAggregate} onLanded={onAssemblyLanded} returnFocus={assemblyReturnFocus} />
    {/* The ready funnel's overlay covers pointer input, but does not trap Tab. */}
    <div className="catalogue-results" inert={assembly.state.phase === 'ready'}>{renderLunii?.({ width: luniiPanelWidth, onSelect: onLuniiSelect, onDeviceChange: onLuniiDeviceChange, dnd })}<div className={`catalogue-main ${floatingSelectionVisible ? 'has-selection-bar' : ''}`}>
    {/* One scrollbar below the fixed bars; useCatalogueWindow measures it. */}
    <div className="catalogue-scroll" data-lunii-drop="catalogue" data-repatriate={dnd.repatriation ? (dnd.repatriation.refusal ? 'refused' : 'ready') : undefined} onClick={viewProps.onBackgroundClick}>{view.items.length
      ? <div className="catalogue-window" ref={window.viewportRef} onFocusCapture={event => {
        focusedItem.current = { id: event.target.id, element: event.target };
        const card = event.target.closest('[data-card-id], [data-focus-card-id]');
        const id = card?.dataset.cardId ?? card?.dataset.focusCardId ?? null;
        if (id) lastFocusedCard.current = id;
        setFocusedCardId(id);
      }} onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) { focusedItem.current = null; setFocusedCardId(null); } }}><View items={view.items} view={stableCardView(viewProps, latestView, viewDelegates.current)} /></div>
      : renderEmpty({ view, cards, sources, tags: tags.items, filtered: view.filtered, onClearFilters: () => { view.setQuery(''); view.dispatch({ type: 'reset' }); } })}</div>
    {floatingSelectionVisible && <SelectionFloatingBar visible={floatingSelectionVisible} cards={data.targets} actions={panelActions} onAction={runSelectionAction} onClear={clearSelection} onTags={event => {
      setTagPopover(tagPopoverAt(event.currentTarget, data.targets.map(card => card.id), 'above'));
    }} />}
    </div>
    {luniiStory && <FicheDialog reservedWidth={luniiWidth} onWidthChange={lunii?.store.resizeFiche} card={{ id: luniiStory.key }} lunii={{ device, story: luniiStory, rows: deviceRows, selected: deviceRows.filter(s => lunii.selection.ids.includes(s.key)), gestures: lunii.gestures, queued: queuedMarks(lunii.luniiQueue?.[device.id]), onCancelQueued: id => lunii.store.cancel(id) }} onClose={() => { lunii.store.select('lunii', []); requestAnimationFrame(() => document.getElementById(`lunii-story-${luniiStory.key}`)?.focus()); }}
      onNavigate={delta => { const index = deviceRows.findIndex(s => s.key === luniiStory.key); const next = deviceRows[index + delta]; if (next) lunii.store.select('lunii', [next.key]); }} />}
    {lunii?.selection.side !== 'lunii' && view.fichePanelVisible && ficheCard && <FicheDialog luniiSend={sendUi.available ? { state: sendUi.stateOf(ficheCard), onSend: deviceId => sendUi.onSend(ficheCard.id, deviceId), onSee: sendUi.onSee } : null} reservedWidth={luniiWidth} onWidthChange={lunii?.store.resizeFiche} actions={panelActions} onSelectionAction={runSelectionAction} key={ficheCard.id} abandonGuard={ficheAbandon} card={ficheCard} selectedCards={data.targets} tags={tags.items}
      position={ficheModalPosition(order, ficheCard.id)} navigationBusy={Boolean(trashCard) || data.busy}
      onNavigate={delta => ficheModal.navigatePanel({ id: ficheCard.id, delta, busy: Boolean(trashCard) || data.busy, openFiche })}
      onTrashActivity={busy => setTrashCard(current => busy ? current ?? ficheCard : null)}
      exemplarRequest={exemplarRequest}
      onAction={id => {
        actionFocus.current = document.getElementById('catalogue-fiche-remove');
        if (id === 'removeFromCatalogue') { void beforeFicheAbandon(ficheAbandon, () => removeOffline([ficheCard])); return; }
      }}
      onClose={closeFiche} onOpenLarge={() => viewProps.onOpenModal(ficheCard.id)} {...panelHandlers} />}
    </div>
    <CatalogueFicheModal modal={ficheModal} cardsById={cardsById} {...ficheServices} />
    <CatalogueStatusBar view={view} cards={cards} appVersion={appVersion} />
    <ExemplarChoiceDialog choice={simulation.choice.state} card={simulation.choice.card} items={simulation.choice.items} dispatch={simulation.choice.dispatch} onChoose={simulation.choice.choose} onCancel={simulation.choice.cancel} />
    <ExemplarChoiceDialog choice={editor.choice.state} card={editor.choice.card} items={editor.choice.items} dispatch={editor.choice.dispatch} onChoose={editor.choice.choose} onCancel={editor.choice.cancel} />
    <CatalogueSimulator consultation={simulation.consultation} onChooseAgain={simulation.chooseAgain} />
    {tagPopover && <CatalogueMenuLayer><TagSubmenu tags={tags.items} targets={tagPopover.targetIds ? tagPopover.targetIds.map(id => cardsById.get(id)).filter(Boolean) : data.targets} busy={data.busy} onMutate={data.mutate} {...tagPopover} onClose={() => setTagPopover(null)} /></CatalogueMenuLayer>}
    {menu.open && target && <CatalogueMenuLayer>
      <CardContextMenu menu={menu} card={target.card} entries={entries} dispatch={menus.dispatch} onActivate={activate} onBack={back}
        tagMenu={{ tags: tags.items, targets: cards.filter(card => card.id === target.card.id), busy: data.busy, onMutate: data.mutate }} />
    </CatalogueMenuLayer>}
  </section></SelectionControlsContext.Provider></LuniiDndFrame>;
}
