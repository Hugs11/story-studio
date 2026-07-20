import { logger } from '../utils/logger';
import { bumpPackVersion } from '../utils/packConvention';

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
}) {
  // Retour à l'accueil : PAS de nouvelle session, c'est un reset. Nettoyage
  // complet mémoire + session + jobs ; après quoi projectType est null → ModeSelector.
  async function handleNewProject() {
    const canContinue = await askSaveBeforeLeaveCurrent(handleSave);
    if (!canContinue) return;
    store.resetProject();
    setMediaLibraryPaths([]);
    savedSnapshotRef.current = null;
    autoSavePathRef.current = null;
    autoSaveSnapshotRef.current = null;
    setAutoSavedPath(null);
    resetWorkSession();
    sdStore.clearDone();
    xttsStore.clearDone();
  }

  async function handleSelectProjectType(type) {
    try {
      await prepareNewWorkSession(type);
    } catch (error) {
      logger.error('session:start-error', error);
      showErrorDialog({
        title: 'Nouveau projet',
        message: `Impossible de préparer le dossier de travail : ${error}`,
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
  async function handleLandEditablePack({ zipPath, packLabel, allowUnsupported = false }) {
    await runFunnelLanding('pack', async (workspaceDir) => {
      const transformed = await unpackZipIntoBlankProject({
        zipPath,
        zipName: packLabel,
        workspaceDir,
        baseProject: store.project,
        allowUnsupported,
      });
      if (!transformed) throw new Error('Aucune histoire éditable trouvée dans ce pack.');
      // Suggérer une version incrémentée (_V2 si aucune) et forcer la modal de
      // métadonnées pré-remplie à la première génération du pack importé.
      const landedProject = transformed.project.packMetadata
        ? {
            ...transformed.project,
            packMetadata: {
              ...transformed.project.packMetadata,
              version: bumpPackVersion(transformed.project.packMetadata.version),
            },
          }
        : transformed.project;
      store.setProject(landedProject);
      store.setSelectedId('root');
      importedPackPendingMetaRef.current = true;
      if (transformed.advancedTransitionsDetected) {
        const firstWarning = transformed.unresolvedTransitions[0]?.message;
        setImportNotice(
          "Certaines transitions du pack importé n'ont pas pu être modélisées complètement. "
          + "Story Studio a conservé la structure reconnue, mais vérifie les retours concernés avant export."
          + (firstWarning ? ` Exemple : ${firstWarning}` : '')
        );
      }
      logger.info(`edit-pack:landed zip='${zipPath}'`);
    }, { errorLog: 'edit-pack:land-error' });
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
    handleSelectProjectType,
    handleEditExistingPack,
    handleLandEditablePack,
    handleSimulatePackReady,
  };
}
