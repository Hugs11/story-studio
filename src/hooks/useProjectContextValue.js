// Construit la valeur de ProjectContext.Provider (plan V, iso-fonctionnel) : le
// contexte consommé par les éditeurs (import/copie projet, audio/image, génération
// SD/XTTS, sauvegarde). Déplacement pur du littéral qui vivait dans AppContent —
// mêmes clés, même ordre, RECONSTRUIT À CHAQUE RENDU (aucune mémoïsation : c'était
// déjà le comportement, et plusieurs sources — project, jobs des stores — changent
// par rendu ; un useMemo les figerait sans warning). Les stores SD/XTTS sont passés
// entiers : le hook en dérive sdSettings/sdJobs/xttsJobs/onRemoveSdResult, exactement
// comme le faisait l'hôte.
export function useProjectContextValue({
  savePath,
  projectName,
  workspaceDir,
  project,
  xttsSettings,
  sdStore,
  xttsStore,
  pathAudit,
  maybeCopyToProject,
  extractAudioEmbeddedImage,
  handleSaveProject,
  handleOpenSDGenerate,
  handleUpdateXttsSettings,
  handleQueueXttsGenerate,
  handleMediaCreated,
}) {
  return {
    savePath,
    projectName,
    workspaceDir,
    globalOptions: project.globalOptions,
    xttsSettings,
    sdSettings: sdStore.sdSettings,
    sdJobs: sdStore.jobs,
    xttsJobs: xttsStore.jobs,
    pathAudit,
    onImportFile: maybeCopyToProject,
    onExtractAudioEmbeddedImage: extractAudioEmbeddedImage,
    onSave: handleSaveProject,
    onOpenSDGenerate: handleOpenSDGenerate,
    onRemoveSdResult: sdStore.removeResult,
    onUpdateXttsSettings: handleUpdateXttsSettings,
    onQueueXttsGenerate: handleQueueXttsGenerate,
    onMediaCreated: handleMediaCreated,
  };
}
