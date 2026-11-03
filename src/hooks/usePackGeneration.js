import { invoke } from '@tauri-apps/api/core';
import { productionRef, translateProduction } from '../i18n/productionPresentation.js';
import { useCallback, useMemo, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { getLastExportDir, saveLastExportDir } from './useFileDialog';
import { ensureExportsDir, projectToRustExport } from '../store/projectIO';
import { getGenerateErrors } from '../store/projectValidation';
import { mediaVerificationProblem, verifyMenuProduction } from '../store/production/mediaVerification.js';
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
  onGenerated = null,
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
        title: productionRef('production:generation.checking.title'),
        message: productionRef('production:generation.checking.message'),
        variant: 'warning',
      });
      return;
    }
    const verification = await verifyMenuProduction(projectForGeneration, pathAudit);
    if (verification.unverifiedPaths.length > 0) {
      showErrorDialog({ ...mediaVerificationProblem(), variant: 'warning' });
      return;
    }
    const validationErrors = verification.errors;
    if (validationErrors.length > 0) {
      logger.warn(`generate:blocked count=${validationErrors.length}`);
      showErrorDialog({
        title: productionRef('production:generation.blocked.title'),
        message: productionRef('production:generation.blocked.message', { get errors() { return { messages: getGenerateErrors(projectForGeneration, verification.statusByPath), separator: '\n• ', data: true }; } }),
      });
      return;
    }
    const defaultPath = await resolveDefaultExportDir();
    const outputFolder = await openDialog({ directory: true, multiple: false, title: translateProduction('production:generation.folder.title'), defaultPath });
    if (!outputFolder) return;
    saveLastExportDir(outputFolder);
    logger.info(`generate:queued projectType=${projectForGeneration.projectType} name='${projectForGeneration.projectName}' outputFolder='${outputFolder}'`);
    renderQueue.addJob({
      ...(onGenerated ? { onGenerated } : {}),
      projectName: projectForGeneration.projectName || '',
      savePath: store.savePath ?? null,
      projectJson: JSON.stringify(projectToRustExport(projectForGeneration)),
      outputFolder,
    });
  }

  async function handleSavePackMetadata(requestedDraft, { generate = false } = {}) {
    // La vignette catalogue n'est pas une métadonnée : elle est retirée du
    // brouillon et écrite à côté, dans les médias de la racine.
    const {
      catalogImage,
      harmonizeLoudness,
      silenceMode,
      leadingSilenceSec,
      trailingSilenceSec,
      ...draft
    } = requestedDraft ?? {};
    const catalogChanged = Object.hasOwn(requestedDraft ?? {}, 'catalogImage');
    const audioSettings = {};
    if (Object.hasOwn(requestedDraft ?? {}, 'harmonizeLoudness')) {
      audioSettings.harmonizeLoudness = harmonizeLoudness;
    }
    if (Object.hasOwn(requestedDraft ?? {}, 'silenceMode')) {
      audioSettings.silenceMode = silenceMode;
    }
    for (const [field, value] of [['leadingSilenceSec', leadingSilenceSec], ['trailingSilenceSec', trailingSilenceSec]]) {
      if (Object.hasOwn(requestedDraft ?? {}, field)) audioSettings[field] = value;
    }
    // Nouvelle révision d'un pack importé : la question est posée avant le
    // sélecteur de dossier de sortie.
    const effectiveDraft = generate && importedPackPendingMetaRef.current
      ? await askImportedUuidRevision(draft, showChoiceDialog, () => invoke('read_pack_identity_lock', { uuid: store.project.packMetadata?.uuid ?? '', officialProvenance: store.project.officialProvenance ?? 'unknown' }))
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
      ...(Object.keys(audioSettings).length > 0 ? {
        globalOptions: { ...(store.project.globalOptions ?? {}), ...audioSettings },
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
