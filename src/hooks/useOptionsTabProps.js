// Construit la surface de props de l'onglet Préférences :
// l'objet transmis à <AppModals optionsTabProps> puis à OptionsTab.
// RECONSTRUIT À CHAQUE RENDU : plusieurs valeurs — settings, project — changent
// par rendu ; un useMemo les figerait sans warning. L'hôte agrège ici les
// valeurs et gestionnaires venus de plusieurs sources :
// préférences (useAppPreferences), média (useMediaTransferHandlers), store SD, states
// de shell (thème, raccourcis, autosave, logging).
export function useOptionsTabProps({
  copyImportedFilesEnabled,
  handleCopyImportedFilesChange,
  workspaceDir,
  configuredWorkspaceDir,
  handlePickWorkspaceDir,
  useWorkspaceForNewProjects,
  setUseWorkspaceForNewProjects,
  handleConsolidateProject,
  autoSaveEnabled,
  setAutoSaveEnabled,
  autoSaveBackupLimit,
  setAutoSaveBackupLimit,
  themePreference,
  setThemePreference,
  keyboardShortcuts,
  setKeyboardShortcuts,
  xttsSettings,
  handleUpdateXttsSettings,
  sdSettings,
  onUpdateSdSettings,
  verboseLogging,
  handleVerboseLoggingChange,
  handleCopyLogPath,
  handleResolveLogPath,
  project,
  savePath,
}) {
  return {
    copyFilesEnabled: copyImportedFilesEnabled,
    onCopyFilesChange: handleCopyImportedFilesChange,
    workspaceDir,
    configuredWorkspaceDir,
    onPickWorkspaceDir: handlePickWorkspaceDir,
    useWorkspaceForNewProjects,
    onUseWorkspaceForNewProjectsChange: setUseWorkspaceForNewProjects,
    onConsolidateProject: handleConsolidateProject,
    autoSaveEnabled,
    onAutoSaveChange: setAutoSaveEnabled,
    autoSaveBackupLimit,
    onAutoSaveBackupLimitChange: setAutoSaveBackupLimit,
    themePreference,
    onThemePreferenceChange: setThemePreference,
    keyboardShortcuts,
    onUpdateKeyboardShortcuts: setKeyboardShortcuts,
    xttsSettings,
    onUpdateXttsSettings: handleUpdateXttsSettings,
    sdSettings,
    onUpdateSdSettings,
    verboseLogging,
    onVerboseLoggingChange: handleVerboseLoggingChange,
    onCopyLogPath: handleCopyLogPath,
    onResolveLogPath: handleResolveLogPath,
    project,
    savePath,
  };
}
