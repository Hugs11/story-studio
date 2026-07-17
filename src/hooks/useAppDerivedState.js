import { useMemo } from 'react';
import { getLastExportDir } from './useFileDialog';
import { useProjectDerivedData } from './useProjectDerivedData';
import { isProjectDirty } from '../store/projectHelpers';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { isTtsAvailable } from '../store/xttsSettings';
import { getShortcutLabelMap } from '../store/keyboardShortcuts';
import { getProjectFilePrefix } from '../utils/projectPrefix';
import { END_NODE_ID } from '../components/diagram/flowDiagramLayout';

// Modèle de lecture du shell : sélection courante, validation, libellé de
// statut, dirty state, capacités toolbar, labels de
// raccourcis et dossier d'export modal. Déplacement pur du bloc qui vivait dans
// AppContent — aucune mutation du projet ici, et AUCUNE MÉMOÏSATION NOUVELLE :
// seuls selectedStatusName et shortcutLabels étaient des useMemo, ils le restent.
// Tout le reste est recalculé à chaque rendu, exprès : projectDirty lit
// savedSnapshotRef.current pendant le rendu (un useMemo raterait la mise à jour
// de la ref après un save) et modalExportFolder lit les settings persistés au
// moment de l'appel via getLastExportDir()/readSetting (un useMemo cesserait de
// suivre le dernier export de la session).
export function useAppDerivedState({
  store,
  projectIndex,
  pathAudit,
  pathAuditPending,
  missingMedia,
  missingMediaSignature,
  dismissedMissingMediaSignature,
  workspaceViewState,
  savedSnapshotRef,
  workspaceDirRef,
  keyboardShortcuts,
  xttsSettings,
}) {
  const {
    selectedNode,
    validationIssues,
    allMenus,
  } = useProjectDerivedData(store.project, {
    selectedId: store.selectedId,
    fileAudit: pathAudit,
    projectIndex,
  });

  const { projectType } = store.project;
  const showMissingMediaRelink = projectType !== null
    && !!store.savePath
    && !pathAuditPending
    && missingMedia.length > 0
    && missingMediaSignature !== dismissedMissingMediaSignature;
  const errors = validationIssues.filter((issue) => issue.status === 'error').length;
  const warnings = validationIssues.filter((issue) => issue.status === 'warning').length;
  const totalIssues = errors + warnings;

  const selectedStatusName = useMemo(() => {
    if (projectType === null) return null;
    if (store.selectedId === END_NODE_ID) return store.project.endNodeName || 'Message de fin';
    if (store.selectedId === 'root') {
      return projectType === 'simple'
        ? (store.project.projectName || 'Mon histoire')
        : (store.project.rootName || store.project.projectName || 'Menu racine');
    }
    const entry = projectIndex.entryById.get(store.selectedId);
    return entry?.name || '(sans nom)';
  }, [projectIndex, projectType, store.project, store.selectedId]);
  const activePanelsLabel = [
    workspaceViewState.showTree && 'arbre',
    workspaceViewState.showSettings && 'réglages',
    workspaceViewState.showDiagram && 'diagramme',
  ].filter(Boolean).join(' + ');
  const statusText = projectType === null
    ? 'Choisis un type de projet'
    : `Sélection : ${selectedStatusName} — panneaux : ${activePanelsLabel}`;
  const projectDirty = savedSnapshotRef.current === null
    ? isProjectDirty(store.project)
    : JSON.stringify(store.project) !== savedSnapshotRef.current;
  const titleBarName = store.project.projectName?.trim() || null;
  const canImportStories = store.project.projectType === 'pack';
  const canAddFolder = canImportStories;
  const canRecord = canImportStories;
  const canGenerateStoryTts = canImportStories && isTtsAvailable(xttsSettings);
  const shortcutLabels = useMemo(() => getShortcutLabelMap(keyboardShortcuts), [keyboardShortcuts]);
  const effectiveProjectFilePrefix = getProjectFilePrefix(store.project, store.savePath);
  const lastExportDir = getLastExportDir();
  const modalExportFolder = (() => {
    if (lastExportDir) return lastExportDir;
    const ws = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
    if (!ws) return null;
    const trimmed = ws.replace(/[\\/]+$/, '');
    const sep = ws.includes('\\') ? '\\' : '/';
    return `${trimmed}${sep}exports`;
  })();
  const canGenerate = projectType !== null && !pathAuditPending && totalIssues === 0;

  return {
    projectType,
    selectedNode,
    validationIssues,
    allMenus,
    showMissingMediaRelink,
    errors,
    warnings,
    totalIssues,
    selectedStatusName,
    activePanelsLabel,
    statusText,
    projectDirty,
    titleBarName,
    canImportStories,
    canAddFolder,
    canRecord,
    canGenerateStoryTts,
    shortcutLabels,
    effectiveProjectFilePrefix,
    modalExportFolder,
    canGenerate,
  };
}
