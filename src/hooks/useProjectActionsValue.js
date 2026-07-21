// Construit la valeur de ProjectActionsContext : l'objet d'actions projet partagé
// entre les surfaces d'édition (arbre, réglages, diagramme),
// consommé via useProjectActions. Déplacement pur du littéral qui vivait dans
// AppContent — mêmes clés, même ordre, RECONSTRUIT À CHAQUE RENDU (aucune
// mémoïsation : plusieurs callbacks capturent modals/store par référence courante et
// canRecord/canGenerateStoryTts changent à chaque rendu ; un useMemo les figerait sans
// warning). L'hôte agrège ici les gestionnaires venus de plusieurs sources : mutations
// (useProjectMutations), imports (useMediaImport), préférences (useAppPreferences),
// toolbar (resté chez l'hôte) + les setters de flags (modals, setYoutubeFunnelMode).
export function useProjectActionsValue({
  store,
  mutations,
  mediaImport,
  preferences,
  toolbar,
  modals,
  setYoutubeFunnelMode,
  canRecord,
  canGenerateStoryTts,
  onOpenMediaAudioTool,
}) {
  return {
    onSelect: store.setSelectedId,
    onReorder: mutations.handleReorder,
    onMoveToMenu: store.moveItemToMenu,
    onAddMenu: mutations.handleAddMenu,
    onAddStoryToMenu: mediaImport.handleAddStoryToMenu,
    onImportStories: mediaImport.handleAddStory,
    onImportFolder: mediaImport.handleImportFolder,
    onImportPodcast: () => modals.open('podcastImport'),
    onImportYoutube: () => setYoutubeFunnelMode('editor'),
    onRecord: toolbar.handleToolbarRecord,
    onGenerateStoryTts: toolbar.handleToolbarStoryTts,
    canRecord,
    canGenerateStoryTts,
    onUnpackZip: mediaImport.handleUnpackZip,
    onUpdateRoot: mutations.handleUpdateRoot,
    onUpdateMedia: store.updateRootMedia,
    onUpdateStoryAudio: store.updateStoryAudio,
    onUpdateMenu: mutations.handleUpdateMenu,
    onDeleteMenu: mutations.handleDeleteMenu,
    onUpdateItem: mutations.handleUpdateItem,
    onDeleteItem: mutations.handleDeleteItem,
    onBulkUpdateItems: mutations.handleBulkUpdateItems,
    onBulkDeleteItems: mutations.handleBulkDeleteItems,
    onSetMenuAsRoot: mutations.handleSetMenuAsRoot,
    onDemoteRootToMenu: mutations.handleDemoteRootToMenu,
    onDuplicate: store.duplicateEntry,
    onPasteEntries: store.pasteEntriesToMenu,
    onCutPasteEntries: store.cutPasteEntriesToMenu,
    onAddEndNode: preferences.handleAddEndNode,
    onRemoveEndNode: preferences.handleRemoveEndNode,
    onUpdateNightModeAudio: (value) => store.updateGlobalEndMessage({ nightModeAudio: value }),
    onUpdateNightMode: (value) => store.updateGlobalOption('nightMode', value),
    onUpdateNightModeReturn: (value) => store.updateGlobalEndMessage({ nightModeReturn: value }),
    onUpdateNightModeHomeReturn: (value) => store.updateGlobalEndMessage({ nightModeHomeReturn: value }),
    onUpdateEndMessageAutoplay: store.updateGlobalEndPlayback,
    onAttachStoryEndToGlobal: store.attachStoryEndToGlobal,
    onOpenMediaAudioTool,
  };
}
