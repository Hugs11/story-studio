import { useSyncedRef } from './useSyncedRef.js';

export function resolveStructureSearchTarget({ projectType, treeVisible, diagramVisible, activeSurface = null }) {
  const treeAvailable = projectType === 'pack' && treeVisible;
  if (activeSurface === 'diagram' && diagramVisible) return 'diagram';
  if (activeSurface === 'tree' && treeAvailable) return 'tree';
  if (treeAvailable) return 'tree';
  if (diagramVisible) return 'diagram';
  return null;
}

function getActiveStructureSurface() {
  const activeElement = document.activeElement;
  if (activeElement?.closest?.('.fd-panel')) return 'diagram';
  if (activeElement?.closest?.('.panel-left')) return 'tree';
  return null;
}

// Table d'actions des raccourcis clavier : maintient shortcutActionsRef, la
// table lue par les listeners installés par useAppShortcuts. Déplacement pur du
// bloc qui vivait dans AppContent.
// useSyncedRef écrit la ref PENDANT le rendu (pas dans un effet) : ne pas le
// remplacer par un useEffect. Les clés sont des ids d'action alignés avec les
// préférences clavier (store/keyboardShortcuts.js) : ne pas les renommer. Les
// raccourcis sauvegarder/sauvegarder sous ne passent pas par cette table, ils
// sont câblés en dur dans useAppShortcuts via saveHandlerRef/saveAsHandlerRef.
export function useAppShortcutActions({
  shortcutActionsRef,
  store,
  modals,
  diagramView,
  setTreeSearchFocusTrigger,
  setDiagramSearchFocusTrigger,
  handleNewProject,
  handleLoad,
  handleAddStory,
  handleGenerate,
  projectType,
  canImportStories,
  canAddFolder,
  canGenerate,
  totalIssues,
}) {
  useSyncedRef(shortcutActionsRef, {
    newProject: handleNewProject,
    openProject: handleLoad,
    importStories: handleAddStory,
    addFolder: () => store.addMenu(),
    openPackOptions: () => modals.open('packOptions'),
    openPreferences: () => modals.open('prefs'),
    toggleTree: diagramView.toggleTree,
    toggleSettings: diagramView.toggleSettings,
    toggleDiagram: diagramView.toggleDiagram,
    generate: handleGenerate,
    focusTreeSearch: () => {
      const target = resolveStructureSearchTarget({
        projectType,
        treeVisible: diagramView.treeVisible,
        diagramVisible: diagramView.showDiagram,
        activeSurface: getActiveStructureSurface(),
      });
      if (target === 'tree') {
        setTreeSearchFocusTrigger((n) => n + 1);
      } else if (target === 'diagram') {
        setDiagramSearchFocusTrigger((n) => n + 1);
      }
    },
    toggleValidation: () => modals.toggle('validation'),
    undo: store.undo,
    redo: store.redo,
    projectActionsVisible: projectType !== null,
    treeSearchVisible: (projectType === 'pack' && diagramView.treeVisible) || diagramView.showDiagram,
    canImportStories,
    canAddFolder,
    canGenerate,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    hasValidationErrors: totalIssues > 0,
  });
}
