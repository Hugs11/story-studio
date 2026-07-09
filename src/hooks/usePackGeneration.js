import { useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getLastExportDir, saveLastExportDir } from './useFileDialog';
import { ensureExportsDir, projectToRustExport } from '../store/projectIO';
import { getGenerateErrors } from '../store/projectValidation';
import { hasExplicitExportPackName } from '../store/projectHelpers';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { generateUuid } from '../utils/uuid';
import { logger } from '../utils/logger';

// Vrai si l'UUID du draft est encore l'UUID importé d'origine (non régénéré via ↺ ni
// modifié). Sert à ne proposer la régénération que quand ça a du sens.
function isImportedOriginalUuid(draft) {
  const current = String(draft?.uuid || '').trim();
  const original = String(draft?.originalUuid || '').trim();
  return !!current && (!original || current === original);
}

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

  async function resolveDefaultExportDir() {
    let defaultPath = getLastExportDir();
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

  async function handleSavePackMetadata(draft, { generate = false } = {}) {
    let effectiveDraft = draft;
    // Nouvelle révision d'un pack importé : proposer (sans obligation) un nouvel UUID
    // AVANT de générer — donc avant le sélecteur de dossier de sortie (dialogue natif
    // OS qui passe devant). Dialogue in-app awaitable, résolu ici puis on continue.
    if (generate && importedPackPendingMetaRef.current && isImportedOriginalUuid(draft)) {
      const choice = await showChoiceDialog({
        title: "Nouvelle révision d'un pack importé",
        message: "Ce pack a un UUID d'origine. Générer un nouvel UUID pour cette version ?\n\n"
          + "Garde l'UUID d'origine seulement pour remplacer exactement la même révision.",
        variant: 'info',
        cancelValue: 'keep',
        actions: [
          { value: 'keep', label: "Garder l'UUID d'origine", kind: 'ghost' },
          { value: 'renew', label: 'Générer un nouvel UUID', kind: 'primary', autoFocus: true },
        ],
      });
      if (choice === 'renew') effectiveDraft = { ...draft, uuid: generateUuid() };
    }
    const nextPackMetadata = { ...(store.project.packMetadata ?? {}), ...effectiveDraft };
    const isSimple = store.project.projectType === 'simple';
    const nextTitle = String(effectiveDraft?.title ?? '').trim();
    const projectForAction = {
      ...store.project,
      packMetadata: nextPackMetadata,
      ...(isSimple && nextTitle ? { projectName: nextTitle } : {}),
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

  return {
    handleGenerate,
    handleSavePackMetadata,
    packMetadata: {
      open: packMetadataOpen,
      openPackMetadata: () => setPackMetadataOpen(true),
      close: () => setPackMetadataOpen(false),
    },
  };
}
