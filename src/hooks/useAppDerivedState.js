import { useEffect, useMemo, useState } from 'react';
import { getLastExportDir } from './useFileDialog';
import { useProjectDerivedData } from './useProjectDerivedData';
import { hasUnsavedWork } from '../store/projectHelpers';
import {
  authoringWorkspaceMode,
  hasProjectTree,
  hierarchicalProjectType,
  isProjectOpen,
  WORKSPACE_MODE_ADVANCED,
} from '../store/projectWorkState';
import { MEDIA_LANDING_LIBRARY, mediaToolLanding } from '../store/mediaToolSurface';
import { shouldProposeMissingMediaRelink } from '../store/missingMediaRelink';
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
// suivre le dernier export de la session). Seul état tenu ici : la proposition
// « Médias introuvables » déjà ouverte, qu'un nouvel audit ne doit pas fermer.
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
  mediaLibraryPaths,
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

  // Garde-fou : un projet avancé n'expose aucun
  // type hiérarchique. Toolbar Libre, panneaux et qualification d'export lisent
  // donc `null`, comme avant tout choix de type.
  //
  // `authoringMode` répond à l'autre question — quel espace de travail monter —
  // et c'est lui qui distingue « aucun projet » de « projet
  // avancé ouvert ». Les deux valeurs sont nécessaires : les confondre
  // renverrait l'avancé à l'accueil, ou monterait l'arbre Libre sur un document
  // qui n'en a pas.
  const projectType = hierarchicalProjectType(store.project);
  const authoringMode = authoringWorkspaceMode(store.project);
  const isAdvanced = authoringMode === WORKSPACE_MODE_ADVANCED;
  // `hasTree` est la capacité « ce projet a un arbre », distincte de
  // « un projet est ouvert ». Les sites qui ne veulent savoir que s'il y a un
  // arbre lisent `hasTree` ; ceux qui lisent la valeur ('pack' / 'simple')
  // gardent `projectType`.
  const hasTree = hasProjectTree(store.project);
  // « Un projet est-il ouvert ? » — vraie pour les deux éditeurs. C'est elle que
  // la barre unique et le bandeau posent, là où ils lisaient l'arbre.
  const projectOpen = isProjectOpen(store.project);
  // La règle vit dans `missingMediaRelink.js`, où elle est éprouvable sans
  // React. Elle pose « un projet est-il ouvert ? » : les manquants
  // d'un projet graphe étaient déjà comptés, et la proposition était la seule
  // chose à ne jamais s'ouvrir. Côté graphe, la reliaison passe par un geste
  // d'auteur annulable — voir `useMissingMediaRelink`.
  // `relinkProposalOpen` retient que la proposition est déjà à l'écran : un
  // audit relancé par le retour de focus ne la ferme pas (voir la règle).
  const [relinkProposalOpen, setRelinkProposalOpen] = useState(false);
  const showMissingMediaRelink = shouldProposeMissingMediaRelink({
    projectOpen,
    savePath: store.savePath,
    pathAuditPending,
    proposalOpen: relinkProposalOpen,
    missingMedia,
    missingMediaSignature,
    dismissedMissingMediaSignature,
  });
  useEffect(() => {
    setRelinkProposalOpen(showMissingMediaRelink);
  }, [showMissingMediaRelink]);
  const errors = validationIssues.filter((issue) => issue.status === 'error').length;
  const warnings = validationIssues.filter((issue) => issue.status === 'warning').length;
  const totalIssues = errors + warnings;

  const selectedStatusName = useMemo(() => {
    if (!hasTree) return null;
    if (store.selectedId === END_NODE_ID) return store.project.endNodeName || 'Message de fin';
    if (store.selectedId === 'root') {
      return projectType === 'simple'
        ? (store.project.projectName || 'Mon histoire')
        : (store.project.rootName || store.project.projectName || 'Menu racine');
    }
    const entry = projectIndex.entryById.get(store.selectedId);
    return entry?.name || '(sans nom)';
  }, [hasTree, projectIndex, projectType, store.project, store.selectedId]);
  const activePanelsLabel = [
    workspaceViewState.showTree && 'arbre',
    workspaceViewState.showSettings && 'réglages',
    workspaceViewState.showDiagram && 'diagramme',
  ].filter(Boolean).join(' + ');
  const statusText = isAdvanced
    ? 'Éditeur graphe — navigation du pack éditée directement'
    : !hasTree
      ? 'Choisis un type de projet'
      : `Sélection : ${selectedStatusName} — panneaux : ${activePanelsLabel}`;
  const projectDirty = hasUnsavedWork({
    project: store.project,
    mediaLibraryPaths,
    mediaTags: store.mediaTags,
    savedSnapshot: savedSnapshotRef.current,
    pristine: store.isPristine(),
  });
  const titleBarName = store.project.projectName?.trim() || null;
  const canImportStories = store.project.projectType === 'pack';
  const canAddFolder = canImportStories;
  // Les outils de son répondent dès qu'ils ont un point d'arrivée. Côté
  // Libre c'est un dossier de l'arbre, donc un projet de type pack — un projet
  // « une seule histoire » n'accueille pas de nouvelle histoire, et ne les
  // offrait déjà pas. Côté graphe c'est la bibliothèque de médias, qui existe
  // dès qu'un projet est ouvert. Les lier au seul `projectType === 'pack'`
  // était ce qui les rendait inatteignables sur un graphe.
  const canUseMediaTools = mediaToolLanding(authoringMode) === MEDIA_LANDING_LIBRARY
    ? projectOpen
    : canImportStories;
  const canRecord = canUseMediaTools;
  const canGenerateStoryTts = canUseMediaTools && isTtsAvailable(xttsSettings);
  const shortcutLabels = useMemo(() => getShortcutLabelMap(keyboardShortcuts), [keyboardShortcuts]);
  const effectiveProjectFilePrefix = getProjectFilePrefix(store.project, store.savePath);
  const lastExportDir = getLastExportDir();
  const modalExportFolder = (() => {
    // Une session de cache n'est jamais un dossier d'export. Pour un projet
    // encore non enregistré, le workspace actif fournit `<workspace>/exports`;
    // sans workspace, le sélecteur demandera explicitement une destination.
    if (store.savePath && lastExportDir) return lastExportDir;
    const ws = workspaceDirRef.current;
    if (!ws) return null;
    const trimmed = ws.replace(/[\\/]+$/, '');
    const sep = ws.includes('\\') ? '\\' : '/';
    return `${trimmed}${sep}exports`;
  })();
  // Génération Libre : elle part de l'arbre. Un projet avancé produit par sa
  // propre chaîne et n'a jamais été qualifié ici.
  const canGenerate = hasTree && !pathAuditPending && totalIssues === 0;

  return {
    projectType,
    hasTree,
    projectOpen,
    authoringMode,
    isAdvanced,
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
