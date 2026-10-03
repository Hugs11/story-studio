export const KEYS = Object.freeze({
  RELEASE_NOTES_SEEN: 'storyStudio.releaseNotesSeen',
  COPY_FILES: 'copyImportedFiles',
  AUTOSAVE_ENABLED: 'autoSaveEnabled',
  AUTOSAVE_DEFAULT_ON_APPLIED: 'storyStudio.autosaveDefaultOnApplied',
  AUTOSAVE_BACKUP_LIMIT: 'autoSaveBackupLimit',
  WORKSPACE_DIR: 'storyStudioWorkspaceDir',
  USE_WORKSPACE_FOR_NEW_PROJECTS: 'storyStudio.useWorkspaceForNewProjects',
  FREE_BOTTOM_PANEL_OPEN: 'storyStudio.free.bottomPanelOpen',
  FREE_BOTTOM_PANEL_TAB: 'storyStudio.free.bottomPanelTab',
  ADVANCED_BOTTOM_PANEL_OPEN: 'storyStudio.advanced.bottomPanelOpen',
  ADVANCED_BOTTOM_PANEL_TAB: 'storyStudio.advanced.bottomPanelTab',
  LAST_EXPORT_DIR: 'lastExportDir',
  LAST_PACK_OUTPUT_DIR: 'lastPackOutputDir',
  LAST_OPEN_PROJECT_DIR: 'lastOpenProjectDir',
  LAST_SAVE_PROJECT_DIR: 'lastSaveProjectDir',
  LAST_PROJECT_DIR: 'lastProjectDir',
  LAST_IMPORT_DIR: 'lastImportDir',
  LAST_IMAGE_IMPORT_DIR: 'lastImageImportDir',
  LAST_AUDIO_IMPORT_DIR: 'lastAudioImportDir',
  LAST_ZIP_IMPORT_DIR: 'lastZipImportDir',
  LAST_AUDIO_ZIP_IMPORT_DIR: 'lastAudioZipImportDir',
  LAST_MULTI_AUDIO_IMPORT_DIR: 'lastMultiAudioImportDir',
  LAST_MULTI_ZIP_IMPORT_DIR: 'lastMultiZipImportDir',
  LAST_MULTI_AUDIO_ZIP_IMPORT_DIR: 'lastMultiAudioZipImportDir',
  LAST_MEDIA_LIBRARY_IMPORT_DIR: 'lastMediaLibraryImportDir',
  LAST_SD_REFERENCE_IMAGE_DIR: 'lastSdReferenceImageDir',
  LAST_COMFY_WORKFLOW_API_DIR: 'lastComfyWorkflowApiDir',
  LAST_COMFY_WORKFLOW_CONFIG_DIR: 'lastComfyWorkflowConfigDir',
  RECENT_PROJECTS: 'recentProjects',
  MEDIA_TAGS_VERSION: 'mediaTagsVersion',
  THEME: 'storyStudioThemePreference',
  SELECTION_OPENS_SETTINGS: 'storyStudio.selectionOpensSettings',
  VERBOSE_LOGGING: 'storyStudio.verboseLogging',
  PACK_LEADING_SILENCE_SECONDS: 'storyStudio.packLeadingSilenceSeconds',
  PACK_TRAILING_SILENCE_SECONDS: 'storyStudio.packTrailingSilenceSeconds',
  XTTS_SETTINGS: 'xttsSettings',
  SD_SETTINGS: 'sdSettings',
  KEYBOARD_SHORTCUTS: 'storyStudioKeyboardShortcuts',
  SD_RESULTS: 'sdJobResults',
  MEDIA_METADATA_PREFIX: 'ss-meta-v2:',
  AUDIO_ASSEMBLY_OPTIONS: 'audio-assembly-opts',
  DIAGRAM_SHOW_TREE: 'diagramShowTree',
  DIAGRAM_SHOW_SETTINGS: 'diagramShowSettings',
  DIAGRAM_SHOW_DIAGRAM: 'diagramShowDiagram',
  WORKSPACE_PANEL_ORDER: 'workspacePanelOrder',
  SETTINGS_PANEL_WIDTH: 'settingsPanelWidth',
  TREE_PANEL_WIDTH: 'treePanelWidth',
  ADVANCED_WORKSPACE_PANEL_ORDER: 'advancedWorkspacePanelOrder',
  ADVANCED_SHOW_NODE_LIST: 'advancedShowNodeList',
  ADVANCED_SHOW_INSPECTOR: 'advancedShowInspector',
  ADVANCED_SHOW_OVERVIEW: 'advancedShowOverview',
  ADVANCED_NODE_LIST_PANEL_WIDTH: 'advancedNodeListPanelWidth',
  ADVANCED_INSPECTOR_PANEL_WIDTH: 'advancedInspectorPanelWidth',
  ADVANCED_NEW_STAGE_CONTROLS: 'advancedNewStageControls',
  FLOW_DIAGRAM_SHOW_RETURNS: 'fd_show_returns',
  TREE_SHOW_DEFAULT_NAVIGATION_BADGES: 'tree_show_default_navigation_badges',
  TREE_SHOW_GUIDES: 'tree_show_guides',
  XTTS_LAST_VOICE: 'xtts_last_voice',
  XTTS_LAST_SPEAKER: 'xtts_last_speaker',
  PIPER_LAST_VOICE: 'piper_last_voice',
  YOUTUBE_CGU_ACCEPTED: 'storyStudio.youtubeCguAccepted',
  YTDLP_CUSTOM_PATH: 'storyStudio.ytDlpCustomPath',
  SIMPLE_MODE_INFO_DISMISS: 'storyStudio.simpleModeInfoDismissed',
  FREE_BOTTOM_PANEL_HEIGHT: 'storyStudio.free.bottomPanelHeight',
  ADVANCED_BOTTOM_PANEL_HEIGHT: 'storyStudio.advanced.bottomPanelHeight',
  FREE_FLOATING_SIMULATOR_GEOMETRY: 'storyStudio.free.floatingSimulatorGeometry',
  ADVANCED_FLOATING_SIMULATOR_GEOMETRY: 'storyStudio.advanced.floatingSimulatorGeometry',
  MEDIA_EXPLORER_COL_WIDTHS: 'me-col-widths-v2',
  MEDIA_EXPLORER_VISIBLE_COLS: 'me-visible-cols-v2',
  AI_QUEUE_COL_WIDTHS: 'aiq-col-widths-v1',
});

export const EDITOR_LAYOUT_SCOPE = Object.freeze({
  FREE: 'free',
  ADVANCED: 'advanced',
});

const EDITOR_LAYOUT_KEYS = Object.freeze({
  [EDITOR_LAYOUT_SCOPE.FREE]: Object.freeze({
    panelOrder: KEYS.WORKSPACE_PANEL_ORDER,
    primaryPanelWidth: KEYS.TREE_PANEL_WIDTH,
    secondaryPanelWidth: KEYS.SETTINGS_PANEL_WIDTH,
    bottomPanelOpen: KEYS.FREE_BOTTOM_PANEL_OPEN,
    bottomPanelTab: KEYS.FREE_BOTTOM_PANEL_TAB,
    bottomPanelHeight: KEYS.FREE_BOTTOM_PANEL_HEIGHT,
    floatingSimulatorGeometry: KEYS.FREE_FLOATING_SIMULATOR_GEOMETRY,
  }),
  [EDITOR_LAYOUT_SCOPE.ADVANCED]: Object.freeze({
    panelOrder: KEYS.ADVANCED_WORKSPACE_PANEL_ORDER,
    primaryPanelWidth: KEYS.ADVANCED_NODE_LIST_PANEL_WIDTH,
    secondaryPanelWidth: KEYS.ADVANCED_INSPECTOR_PANEL_WIDTH,
    bottomPanelOpen: KEYS.ADVANCED_BOTTOM_PANEL_OPEN,
    bottomPanelTab: KEYS.ADVANCED_BOTTOM_PANEL_TAB,
    bottomPanelHeight: KEYS.ADVANCED_BOTTOM_PANEL_HEIGHT,
    floatingSimulatorGeometry: KEYS.ADVANCED_FLOATING_SIMULATOR_GEOMETRY,
  }),
});

export function editorLayoutKeys(scope) {
  const keys = EDITOR_LAYOUT_KEYS[scope];
  if (!keys) throw new Error(`Périmètre de disposition inconnu : ${scope}`);
  return keys;
}

const LEGACY_BOTTOM_PANEL_KEYS = Object.freeze({
  bottomPanelOpen: 'bottomPanelOpen',
  bottomPanelTab: 'bottomPanelTab',
  bottomPanelHeight: 'bottomPanelHeight',
});
const EDITOR_LAYOUT_MIGRATION_APPLIED = 'storyStudio.editorLayoutMigrationApplied';

function storage() {
  return typeof window !== 'undefined' ? window.localStorage : globalThis.localStorage;
}

export function read(key, { defaultValue = null, parse } = {}) {
  try {
    const value = storage()?.getItem(key);
    if (value == null) return defaultValue;
    return parse ? parse(value) : value;
  } catch {
    return defaultValue;
  }
}

export function write(key, value, { serialize } = {}) {
  try {
    storage()?.setItem(key, serialize ? serialize(value) : value);
  } catch {}
}

export function remove(key) {
  try {
    storage()?.removeItem(key);
  } catch {}
}

// Migrations ponctuelles des réglages persistés, appelées au boot (main.jsx)
// avant le montage de l'app.
export function runSettingsMigrations() {
  remove('showCentralDiagram');
  remove('fd_auto_open_settings');
  remove('fd_inspector_width');

  // Vague 2 : la machine « ferme/colonne/plein » + slot gauche est remplacée par
  // 3 bascules de panneaux indépendantes (showTree/showSettings/showDiagram, dont
  // les défauts sont fournis par useWorkspaceViewState). La vue n'est pas une donnée
  // projet : on purge simplement les clés de l'ancien modèle, sans migrer de valeur.
  remove('diagramViewState');
  remove('diagramLastOpenState');
  remove('diagramPleinLeftSlot');
  remove('diagramSettingsSlotWidth');
  remove('diagramColumnWidth');

  // L'enregistrement automatique devient actif par défaut.
  // `usePersistentState` a toujours écrit la valeur par défaut dès le montage,
  // donc un 'false' stocké ne distingue pas un choix explicite d'un défaut
  // hérité : bascule one-shot vers 'true'. Désactiver ensuite reste respecté.
  if (read(KEYS.AUTOSAVE_DEFAULT_ON_APPLIED) == null) {
    write(KEYS.AUTOSAVE_ENABLED, 'true');
    write(KEYS.AUTOSAVE_DEFAULT_ON_APPLIED, '1');
  }

  // Avant 0.9.9, le panneau inférieur était commun aux deux éditeurs.
  // Dupliquer ses trois valeurs préserve exactement la disposition existante
  // au premier démarrage, puis le marqueur empêche toute resynchronisation :
  // les deux surfaces peuvent ensuite diverger sans s'écraser.
  if (read(EDITOR_LAYOUT_MIGRATION_APPLIED) == null) {
    const scopes = [EDITOR_LAYOUT_SCOPE.FREE, EDITOR_LAYOUT_SCOPE.ADVANCED];
    for (const field of Object.keys(LEGACY_BOTTOM_PANEL_KEYS)) {
      const legacyKey = LEGACY_BOTTOM_PANEL_KEYS[field];
      const legacyValue = read(legacyKey);
      if (legacyValue != null) {
        for (const scope of scopes) {
          const targetKey = editorLayoutKeys(scope)[field];
          if (read(targetKey) == null) write(targetKey, legacyValue);
        }
      }
      remove(legacyKey);
    }
    write(EDITOR_LAYOUT_MIGRATION_APPLIED, '1');
  }
}
