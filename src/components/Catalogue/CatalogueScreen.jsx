import { beforeFicheAbandon } from '../../store/catalogue/metadataDraft.js';
import { withCardTitles, withKnownOrphans } from '../../store/catalogue/luniiDevices.js';
import { queueReports, withQueuedOrder } from '../../store/catalogue/luniiQueueView.js';
import { useLuniiGestures } from '../../hooks/useLuniiGestures.js';
import { useLuniiDevices } from '../../hooks/useLuniiDevices.js';
import { useLuniiSend } from '../../hooks/useLuniiSend.js';
import { useSendExemplarChoice } from '../../hooks/useSendExemplarChoice.js';
import { ExemplarChoiceDialog } from './open/ExemplarChoiceDialog.jsx';
import { LuniiPanel } from './lunii/LuniiPanel.jsx';
import { useCatalogueLuniiConsent } from '../../hooks/useCatalogueLuniiConsent.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatalogueTranslation } from '../../i18n/useCatalogueTranslation.js';
import { catalogueApi, presentCatalogueError } from '../../store/catalogue/catalogueApi.js';
import { useCatalogueSourceActions } from '../../hooks/useCatalogueSourceActions.js';
import { useCatalogueAddFolders } from '../../hooks/useCatalogueAddFolders.js';
import { FolderAddedNotice } from './FolderAddedNotice.jsx';
import { useCatalogueSources } from '../../hooks/useCatalogueSources.js';
import { useCatalogueOperations } from '../../hooks/useCatalogueOperations.js';
import { useCatalogueFilters } from '../../hooks/useCatalogueFilters.js';
import { loadScanAdditions } from '../../store/catalogue/scanAdditions.js';
import { useCatalogueEntries } from '../../hooks/useCatalogueEntries.js';
import { operationView, recentOperations, summaryVisible } from '../../store/catalogue/operationView.js';
import { CatalogueChrome, CATALOGUE_MENU_ID } from './CatalogueChrome.jsx';
import { TitleBar } from '../layout/TitleBar.jsx';
import { catalogueDataApi } from '../../store/catalogue/catalogueDataApi.js';
import { useErrorDialog } from '../common/Dialog.jsx';
import { CatalogueBrowser } from './CatalogueBrowser.jsx';
import { CatalogueEmptyState } from './CatalogueEmptyState.jsx';
import './CatalogueScreen.css';

export const CataloguePlaceholder = CatalogueEmptyState;
export function CatalogueScreen({ leaveGuard, onLandAggregate, workspaceDir, onClose, onPreferences, titleBar = null, bottomBar = null, preferencesSurface, editorHost, sessionRecoveries, onRecoverSession, onIgnoreSessionRecovery, api = catalogueApi() }) {
  const { t, line } = useCatalogueTranslation();
  const luniiState = useLuniiDevices();
  const gestures = useLuniiGestures(luniiState);

  const sources = useCatalogueSources(workspaceDir, { api });
  const entries = useCatalogueEntries({ api });
  const operations = useCatalogueOperations({ api, cards: entries.cards });
  // Waiting moves are shown at once; gestures and drops then read the order the user sees.
  const luniiBase = { ...luniiState, luniiDevices: withQueuedOrder(withCardTitles(withKnownOrphans(luniiState.luniiDevices, entries.cards), entries.cards), luniiState.luniiQueue), gestures };
  const sendChoice = useSendExemplarChoice();
  const send = useLuniiSend({ lunii: luniiBase, operations, cards: entries.cards, revision: entries.revision, chooseExemplar: sendChoice.ask });
  const lunii = { ...luniiBase, send };
  const sendBridge = useRef(null);
  const sends = { contextFor: send.contextFor, contexts: send.contexts, devices: lunii.luniiDevices,
    handlers: { see: (deviceId, key) => { lunii.store.selectDevice(deviceId); lunii.store.collapse(false); lunii.store.select('lunii', [key]); }, openEditor: id => sendBridge.current?.openEditor(id) } };
  const filters = useCatalogueFilters();
  const additionsRequest = useRef(0);
  useEffect(() => () => { additionsRequest.current += 1; }, []);
  async function showAdditions(operationId) {
    const request = ++additionsRequest.current;
    try {
      const report = await loadScanAdditions(api, operationId);
      if (request !== additionsRequest.current) return;
      filters.dispatch({ type: 'additions', report });
    } catch (error) { if (request === additionsRequest.current) setActionError(error); }
  }
  const { showChoiceDialog } = useErrorDialog();
  const [removing, setRemoving] = useState(false);
  const [actionError, setActionError] = useState(null);
  useCatalogueLuniiConsent(api, setActionError);
  const [browserNotice, setBrowserNotice] = useState(null);
  const announce = useCallback((notice) => { setActionError(null); setBrowserNotice(notice); }, []);
  const reportError = useCallback((error) => { setBrowserNotice(null); setActionError(error); }, []);
  const initialized = useRef(false);
  useEffect(() => {
    if (initialized.current || sources.loading || !operations.ready) return;
    initialized.current = true;
    // A first workspace is registered on opening this screen. Previously
    // registered sources already have the engine's startup operation.
    if (Object.keys(operations.state.items).length === 0 && sources.items.some((s) => s.status === 'active')) {
      void operations.start(sources.sourcesRevision, { automatic: true }).catch(setActionError);
    }
  }, [sources.loading, sources.sourcesRevision, sources.items, operations.ready, operations.state.items, operations.start]);
  useEffect(() => { document.getElementById('catalogue-title')?.focus(); }, []);
  const ficheAbandon = useRef(null);
  useEffect(() => {
    if (!leaveGuard) return undefined;
    leaveGuard.current = () => beforeFicheAbandon(ficheAbandon, () => true);
    return () => { leaveGuard.current = null; };
  }, [leaveGuard]);
  const home = () => beforeFicheAbandon(ficheAbandon, () => { onClose(); requestAnimationFrame(() => document.getElementById('mode-open-catalogue')?.focus()); });
  function showMissing() {
    additionsRequest.current += 1;
    filters.dispatch({ type: 'showMissing' });
    document.getElementById('catalogue-search')?.focus();
  }
  const { add } = useCatalogueSourceActions(sources, operations, setActionError);
  const folders = useCatalogueAddFolders({ add, sources: sources.items, onNotice: announce, onError: reportError });
  const recent = recentOperations(operations.state);
  const running = recent.some((s) => !operationView(s).terminal);
  const summaries = recent.filter(snapshot => summaryVisible(snapshot, operations.state));
  const fatal = entries.status === 'error' && entries.cards.length === 0;
  // A permanent failure has one empty-state message, never a second notice.
  // Source failures are fixed in Preferences > Catalogue; a scan failure stays
  // in its summary.
  const errors = [
    { error: lunii.error, queueEntryId: lunii.errorQueueEntryId, onDismiss: lunii.store.dismissError, ...(lunii.conflictKey ? { orphanConflict: true, onSelect: () => { lunii.store.selectDevice(lunii.conflictDeviceId); lunii.store.collapse(false); lunii.store.select('lunii', [lunii.conflictKey]); } } : {}) },
    { error: actionError, onDismiss: () => setActionError(null) },
    { error: sources.mutationError, onSelect: onPreferences }, { error: sources.error, onSelect: onPreferences },
    { error: operations.state.error }, { error: entries.error },
    ...(sources.warnings ?? []).map(error => ({ error, onSelect: onPreferences })),
  ].filter(entry => entry.error).filter(entry => !fatal || presentCatalogueError(entry.error).message !== presentCatalogueError(entries.error).message)
    .filter((entry, index, list) => list.findIndex(other => presentCatalogueError(other.error).message === presentCatalogueError(entry.error).message) === index);
  const missing = entries.cards.filter(card => card.offlineReason === 'missing');
  async function removeMissing() {
    if (removing) return;
    setRemoving(true);
    try {
      const preview = await catalogueDataApi.previewRemoveCards(missing.map(card => card.id));
      const confirmed = await showChoiceDialog({ title: t('catalogue:header.removeMissing'),
        message: t('catalogue:sources.remove.confirm', { count: preview.count }),
        actions: [{ value: false, label: t('catalogue:data.cancel'), autoFocus: true }, { value: true, label: t('catalogue:data.confirm'), kind: 'danger' }] });
      if (confirmed === true) { await catalogueDataApi.removeCards(preview.ficheIds, preview.catalogueRevision); await entries.refresh(); }
    } catch (error) { reportError(error); } finally { setRemoving(false); }
  }
  return <main className="catalogue-screen" data-modal="catalogue" data-modal-surface="catalogue" aria-labelledby="catalogue-title">
    <TitleBar section={t('catalogue:screen.title.label')} showProjectMeta={false} onOpenCredits={titleBar?.onOpenCredits} onOpenPreferences={onPreferences} preferencesShortcut={titleBar?.preferencesShortcut} />
    <h1 id="catalogue-title" className="catalogue-visually-hidden" tabIndex={-1}>{t('catalogue:screen.title.label')}</h1>
    <CatalogueBrowser abandonGuard={ficheAbandon} lunii={lunii} sendBridge={sendBridge} renderLunii={props => <LuniiPanel lunii={lunii} {...props} />} onLandAggregate={onLandAggregate} onAssemblyLanded={onClose} ready={entries.status === 'ready'} onRefresh={entries.refresh} onFavoritePatch={entries.patchFavorite} onOpenEditor={editorHost?.open} onWarning={editorHost?.warning} sources={sources.items} cards={entries.cards} revision={entries.revision} api={api} onAnnounce={announce} onError={reportError} appVersion={bottomBar?.appVersion}
      renderHeader={({ searchControls, viewControls, activeFilters, onDuplicates }) => <CatalogueChrome searchControls={searchControls} viewControls={viewControls} activeFilters={activeFilters} lunii={lunii} onHome={home} onPreferences={onPreferences} onDuplicates={onDuplicates} activity={{
        fallbackFocusId: CATALOGUE_MENU_ID, errors, onPreferences, sends,
        luniiQueue: { entries: luniiState.luniiQueue, reports: queueReports(luniiState.luniiQueue), onDismiss: lunii.store.dismissQueueReport },
        missing, removing, onRemoveMissing: removeMissing, onShowMissing: showMissing,
        running: recent.filter(s => !operationView(s).terminal), onCancel: operations.cancel,
        summaries, api, onDismissSummary: operations.dismiss, onDismissLocal: send.dismissLocal, onShowAdditions: showAdditions,
        sourceNotice: sources.notice, browserNotice: lunii.notice ?? browserNotice, onDismissBrowserNotice: () => { lunii.store.dismissNotice(); setBrowserNotice(null); },
        recoveries: sessionRecoveries, onRecoverSession, onIgnoreSessionRecovery,
      }} />}
      renderEmpty={({ filtered, onClearFilters, ...emptyContext }) => fatal
        ? <section className="catalogue-panel" role="status"><h2>{t('catalogue:header.unavailable')}</h2></section>
        : <CataloguePlaceholder {...emptyContext} sources={sources.items} count={0} loading={entries.status === 'loading'} scanning={running} filtered={filtered} onAddFolder={folders.choose} onPreferences={onPreferences} onClearFilters={onClearFilters} />} />
    <div className="catalogue-visually-hidden" aria-live="polite" aria-atomic="true">{browserNotice ? line(browserNotice) : ''}</div>
    <FolderAddedNotice stamp={folders.added} onPreferences={onPreferences} onClose={folders.dismiss} />
    <ExemplarChoiceDialog choice={sendChoice.choice.state} card={sendChoice.choice.card} items={sendChoice.choice.items} dispatch={sendChoice.choice.dispatch} onChoose={sendChoice.choice.choose} onCancel={sendChoice.choice.cancel} />
    {editorHost?.surface}
    {preferencesSurface}
  </main>;
}
