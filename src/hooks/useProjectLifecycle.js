import { landAggregate, prepareAggregateLanding } from '../components/AggregatePacks/aggregateLanding.js';
import { catalogueAssemblyApi } from '../store/catalogue/catalogueAssemblyApi.js';
import { copyMediaToWorkspace } from '../store/projectIO.js';
import { createElement, useEffect, useRef } from 'react';
import i18next from 'i18next';
import { translateHome as t } from '../i18n/homePresentation.js';
import { HomeText } from '../i18n/useHomeTranslation.js';
import { presentUserMessage } from '../i18n/userMessage.js';
import { presentImportWarning } from '../i18n/importWarnings.js';
import { ensureProjectStorage } from '../store/projectStorage';
import { logger } from '../utils/logger';
import { DEFAULT_PROJECT } from '../store/projectStore';

// Grappe « cycle de vie du projet » extraite d'AppContent : retour à l'accueil
// (reset vers l'accueil, PAS de session), choix du type (création de
// la session éphémère) et atterrissage depuis les funnels « Modifier un pack »
// (éditable) / « Simuler » (non éditable). Orchestre useWorkSession + la garde de
// sauvegarde.
//
// Trois fournisseurs en amont : runFunnelLanding/prepareNewWorkSession/resetWorkSession
// (useWorkSession), handleSave (useSaveProgress) et unpackZipIntoBlankProject
// (useImportSession, plus tard ré-exposé par useMediaImport). Le hook doit donc être
// appelé APRÈS ces trois hooks.
//
// askSaveBeforeLeaveCurrent reste chez l'hôte (elle est aussi passée à
// useWindowCloseGuard et dépend de cleanupEphemeralSession) : le hook la REÇOIT en
// entrée, il ne duplique pas la garde.
export function useProjectLifecycle({
  store,
  askSaveBeforeLeaveCurrent,
  handleSave,
  prepareNewWorkSession,
  runFunnelLanding,
  resetWorkSession,
  unpackZipIntoBlankProject,
  savedSnapshotRef,
  autoSavePathRef,
  autoSaveSnapshotRef,
  importedPackPendingMetaRef,
  setMediaLibraryPaths,
  setAutoSavedPath,
  sdStore,
  xttsStore,
  setEditPackOpen,
  setPendingSimulateZip,
  setImportNotice,
  showErrorDialog,
  onOpenCatalogue = null,
  confirmBackgroundWork = async () => true,
}) {
  const importNoticeRef = useRef(null);
  useEffect(() => {
    const refresh = () => {
      const owned = importNoticeRef.current;
      if (!owned) return;
      const example = presentImportWarning(owned.warning);
      const next = example ? t('home:project.landing.importNoticeExample', { example }) : t('home:project.landing.importNotice');
      setImportNotice((current) => current === owned.text ? next : current);
      owned.text = next;
    };
    i18next.on('languageChanged', refresh);
    return () => i18next.off('languageChanged', refresh);
  }, [setImportNotice]);

  // Retour à l'accueil : PAS de nouvelle session, c'est un reset. Nettoyage
  // complet mémoire + session + jobs ; après quoi projectType est null → ModeSelector.
  async function leaveProject(beforeReset = null) {
    if (!await confirmBackgroundWork()) return false;
    const canContinue = await askSaveBeforeLeaveCurrent(handleSave);
    if (!canContinue) return false;
    beforeReset?.();
    store.resetProject();
    setMediaLibraryPaths([]);
    savedSnapshotRef.current = null;
    autoSavePathRef.current = null;
    autoSaveSnapshotRef.current = null;
    setAutoSavedPath(null);
    resetWorkSession();
    sdStore.clearDone();
    xttsStore.clearDone();
    return true;
  }

  async function handleNewProject() { return leaveProject(); }

  async function handleReturnToCatalogue() {
    return leaveProject(onOpenCatalogue);
  }

  async function handleSelectProjectType(type) {
    try {
      await prepareNewWorkSession(type);
      // Un projet vierge n'a rien à perdre tant que l'auteur n'y touche pas.
      store.markPristine();
    } catch (error) {
      logger.error('session:start-error', error);
      showErrorDialog({
        title: createElement(HomeText, { messageKey: 'home:project.creation.title' }),
        technicalDetail: presentUserMessage(error, { allowLegacyFrench: false }).technicalDetail,
        message: { userMessage: error, codedOnly: true, prefix: { key: 'home:project.landing.preparePrefix' }, suffix: `` },
      });
    }
  }

  // Entrée accueil « Modifier un pack » : ouvre le funnel dédié
  // (zone de dépôt fichier/dossier, vérification d'éditabilité et
  // décompression affichées dans le funnel).
  function handleEditExistingPack() {
    setEditPackOpen(true);
  }

  // Pack éditable confirmé par le funnel : crée la session éphémère, extrait le
  // pack (décompression affichée DANS le funnel) puis atterrit dans l'éditeur.
  // Lève en cas d'échec ; la session créée est nettoyée pour revenir proprement
  // à l'accueil (le funnel ré-affiche alors la zone de dépôt).
  async function handleLandEditablePack({ zipPath, packLabel }) {
    await runFunnelLanding('pack', async (workspaceDir, session) => {
      const transformed = await unpackZipIntoBlankProject({
        zipPath,
        zipName: packLabel,
        workspaceDir,
        // Le pack remplace le travail ouvert : il part du projet par défaut,
        // comme depuis l'accueil, jamais du projet encore affiché.
        baseProject: ensureProjectStorage(DEFAULT_PROJECT),
        ephemeral: session?.mode !== 'project',
      });
      if (!transformed) throw { key: 'home:project.landing.noStories', params: {} };
      // Comme l'atterrissage graphe : nouvelle époque, rien de l'ancien projet.
      const depthOutcome = store.loadProject(transformed.project);
      if (!depthOutcome.allowed) {
        throw depthOutcome.message || { key: 'home:project.landing.depthLimit', params: {} };
      }
      store.setSelectedId('root');
      // Comme l'atterrissage graphe : ni les étiquettes, ni la médiathèque, ni
      // la signature d'enregistrement de l'ancien projet ne passent dans le pack.
      store.setMediaTags({});
      setMediaLibraryPaths([]);
      savedSnapshotRef.current = null;
      // Le pack d'origine reste sur le disque : tant que l'auteur n'y touche
      // pas, en ressortir ne perd rien.
      store.markPristine();
      importedPackPendingMetaRef.current = true;
      if (transformed.advancedTransitionsDetected) {
        const firstWarning = presentImportWarning(transformed.unresolvedTransitions[0]);
        const text = firstWarning ? t('home:project.landing.importNoticeExample', { example: firstWarning }) : t('home:project.landing.importNotice');
        importNoticeRef.current = { text, warning: transformed.unresolvedTransitions[0] };
        setImportNotice(text);
      }
      logger.info(`edit-pack:landed zip='${zipPath}'`);
    }, { errorLog: 'edit-pack:land-error' });
  }

  async function handleLandAggregate({ draft, preparation }) {
    return landAggregate({
      confirmBackgroundWork,
      confirmSave: () => askSaveBeforeLeaveCurrent(handleSave),
      runLanding: runFunnelLanding,
      prepare: workspaceDir => prepareAggregateLanding({
        draft, preparation, workspaceDir,
        transfer: catalogueAssemblyApi.transfer,
        requestId: crypto.randomUUID(),
        copy: (path, dir) => copyMediaToWorkspace(path, dir, undefined, draft.metadata.title),
      }),
      install: project => {
        const outcome = store.loadProject(project);
        if (!outcome.allowed) throw outcome.message || { key: 'home:project.landing.depthLimit', params: {} };
        store.setSelectedId('root');
        store.setMediaTags({});
        setMediaLibraryPaths([]);
        savedSnapshotRef.current = null;
        importedPackPendingMetaRef.current = false;
        sdStore.clearDone();
        xttsStore.clearDone();
      },
    });
  }

  // Pack non éditable : le funnel propose la simulation. Session éphémère
  // minimale + pack en entrée ZIP + ouverture du simulateur (lecture seule).
  async function handleSimulatePackReady({ zipPath, packLabel }) {
    await prepareNewWorkSession('pack');
    store.addZip(null, zipPath, packLabel, null, null);
    setPendingSimulateZip(zipPath);
  }

  return {
    handleNewProject,
    handleReturnToCatalogue,
    handleSelectProjectType,
    handleEditExistingPack,
    handleLandEditablePack,
    handleLandAggregate,
    handleSimulatePackReady,
  };
}
