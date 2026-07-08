import { useSyncedRef } from './useSyncedRef';

// Table d'actions des raccourcis clavier (plan U, iso-fonctionnel) : maintient
// shortcutActionsRef, la table lue par les listeners installés par
// useAppShortcuts. Déplacement pur du bloc qui vivait dans AppContent.
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
    focusTreeSearch: () => setTreeSearchFocusTrigger((n) => n + 1),
    toggleValidation: () => modals.toggle('validation'),
    undo: store.undo,
    redo: store.redo,
    projectActionsVisible: projectType !== null,
    treeSearchVisible: diagramView.treeVisible,
    canImportStories,
    canAddFolder,
    canGenerate,
    canUndo: store.canUndo,
    canRedo: store.canRedo,
    hasValidationErrors: totalIssues > 0,
  });
}
