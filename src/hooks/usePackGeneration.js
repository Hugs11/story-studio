import { useCallback, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getLastExportDir, saveLastExportDir } from './useFileDialog';
import { ensureExportsDir, projectToRustExport } from '../store/projectIO';
import { getGenerateErrors } from '../store/projectValidation';
import { hasExplicitExportPackName } from '../store/projectHelpers';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { logger } from '../utils/logger';
import { askImportedUuidRevision } from './importedUuidRevision';

// Grappe « générer le pack » extraite d'AppContent : étape métadonnées
// (PackNameModal), gardes de validation (audit en cours puis erreurs bloquantes),
// résolution du dossier d'export et enfilement du job de génération dans la file
// de rendu.
//
// `importedPackPendingMetaRef` est PARTAGÉE avec useWorkSession : le hook la
// lit et la remet à false après confirmation des métadonnées ; ne pas en créer de
// copie locale.
export function usePackGeneration({
  store,
  renderQueue,
  pathAudit,
  pathAuditPending,
  workspaceDirRef,
  importedPackPendingMetaRef,
  showErrorDialog,
  showChoiceDialog,
}) {
  const [packMetadataOpen, setPackMetadataOpen] = useState(false);
  // Les deux gestes de la fiche sont stables : le bouton de
  // production du graphe ouvre cette fiche, et une identité qui change à chaque
  // rendu ferait reconstruire la commande de production — donc le raccourci et
  // le bouton — à chaque battement de l'export.
  const openPackMetadata = useCallback(() => setPackMetadataOpen(true), []);
  const closePackMetadata = useCallback(() => setPackMetadataOpen(false), []);

  async function resolveDefaultExportDir() {
    // Avant le premier enregistrement, ne jamais proposer le dossier de la
    // session de cache ni un ancien choix sans rapport avec le projet courant.
    let defaultPath = store.savePath ? getLastExportDir() : undefined;
    if (!defaultPath) {
      const ws = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
      if (ws) {
        const exportsDir = await ensureExportsDir(ws);
        if (exportsDir) defaultPath = exportsDir;
      }
    }
    return defaultPath;
  }

  async function handleGenerate(projectOverride = null, { skipMetadata = false } = {}) {
    const projectForGeneration = projectOverride && !projectOverride?.preventDefault
      ? projectOverride
      : store.project;
    // Étape « métadonnées » avant de générer : on nomme/confirme le pack avant.
    // Éditeur libre (pack) : toujours. Mode simple : seulement si le nom d'export
    // n'est pas encore défini (comportement existant conservé pour ce premier tour).
    const isPack = projectForGeneration.projectType === 'pack';
    const isSimple = projectForGeneration.projectType === 'simple';
    const needsMetadataStep = !skipMetadata && (
      isPack
      || (isSimple && (!hasExplicitExportPackName(projectForGeneration) || importedPackPendingMetaRef.current))
    );
    if (needsMetadataStep) {
      setPackMetadataOpen(true);
      return;
    }
    if (pathAuditPending) {
      showErrorDialog({
        title: 'Vérification en cours',
        message: 'Vérification des fichiers du projet en cours. Attendez une seconde puis réessayez.',
        variant: 'warning',
      });
      return;
    }
    const validationErrors = getGenerateErrors(projectForGeneration, pathAudit);
    if (validationErrors.length > 0) {
      logger.warn(`generate:blocked count=${validationErrors.length}`);
      showErrorDialog({
        title: 'Impossible de générer',
        message: `Impossible de générer le pack :\n\n• ${validationErrors.join('\n• ')}`,
      });
      return;
    }
    const defaultPath = await resolveDefaultExportDir();
    const outputFolder = await openDialog({ directory: true, multiple: false, title: 'Dossier de sortie du pack', defaultPath });
    if (!outputFolder) return;
    saveLastExportDir(outputFolder);
    logger.info(`generate:queued projectType=${projectForGeneration.projectType} name='${projectForGeneration.projectName}' outputFolder='${outputFolder}'`);
    renderQueue.addJob({
      projectName: projectForGeneration.projectName || '(sans nom)',
      savePath: store.savePath ?? null,
      projectJson: JSON.stringify(projectToRustExport(projectForGeneration)),
      outputFolder,
    });
  }

  async function handleSavePackMetadata(requestedDraft, { generate = false } = {}) {
    // La vignette catalogue n'est pas une métadonnée : elle est retirée du
    // brouillon et écrite à côté, dans les médias de la racine.
    const { catalogImage, ...draft } = requestedDraft ?? {};
    const catalogChanged = Object.hasOwn(requestedDraft ?? {}, 'catalogImage');
    // Nouvelle révision d'un pack importé : la question est posée avant le
    // sélecteur de dossier de sortie.
    const effectiveDraft = generate && importedPackPendingMetaRef.current
      ? await askImportedUuidRevision(draft, showChoiceDialog)
      : draft;
    const nextPackMetadata = { ...(store.project.packMetadata ?? {}), ...effectiveDraft };
    const isSimple = store.project.projectType === 'simple';
    const nextTitle = String(effectiveDraft?.title ?? '').trim();
    const projectForAction = {
      ...store.project,
      packMetadata: nextPackMetadata,
      ...(isSimple && nextTitle ? { projectName: nextTitle } : {}),
      // Sans image propre, la vignette reprend l'image racine (`sameImage`).
      ...(catalogChanged ? {
        sameImage: !catalogImage,
        thumbnailImage: catalogImage || store.project.rootImage || null,
      } : {}),
    };
    if (!generate) {
      store.setProject(projectForAction);
      setPackMetadataOpen(false);
      return;
    }
    store.setProject(projectForAction);
    setPackMetadataOpen(false);
    // L'utilisateur a confirmé les métadonnées : ne plus reforcer la modal.
    importedPackPendingMetaRef.current = false;
    // skipMetadata : on revient de la modale, on génère sans la rouvrir (évite la boucle).
    if (generate) await handleGenerate(projectForAction, { skipMetadata: true });
  }

  const packMetadata = useMemo(() => ({
    open: packMetadataOpen,
    openPackMetadata,
    close: closePackMetadata,
  }), [packMetadataOpen, openPackMetadata, closePackMetadata]);

  return {
    handleGenerate,
    handleSavePackMetadata,
    packMetadata,
  };
}
