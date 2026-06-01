export const KEYS = Object.freeze({
  COPY_FILES: 'copyImportedFiles',
  AUTOSAVE_ENABLED: 'autoSaveEnabled',
  AUTOSAVE_BACKUP_LIMIT: 'autoSaveBackupLimit',
  WORKSPACE_DIR: 'storyStudioWorkspaceDir',
  SHOW_CENTRAL_DIAGRAM: 'showCentralDiagram',
  BOTTOM_PANEL_OPEN: 'bottomPanelOpen',
  BOTTOM_PANEL_TAB: 'bottomPanelTab',
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
  VERBOSE_LOGGING: 'storyStudio.verboseLogging',
  XTTS_SETTINGS: 'xttsSettings',
  SD_SETTINGS: 'sdSettings',
  KEYBOARD_SHORTCUTS: 'storyStudioKeyboardShortcuts',
  SD_RESULTS: 'sdJobResults',
  MEDIA_METADATA_PREFIX: 'ss-meta-v2:',
  AUDIO_ASSEMBLY_OPTIONS: 'audio-assembly-opts',
  FLOW_DIAGRAM_AUTO_OPEN_SETTINGS: 'fd_auto_open_settings',
  FLOW_DIAGRAM_INSPECTOR_WIDTH: 'fd_inspector_width',
  FLOW_DIAGRAM_SHOW_RETURNS: 'fd_show_returns',
  TREE_SHOW_DEFAULT_NAVIGATION_BADGES: 'tree_show_default_navigation_badges',
  XTTS_LAST_VOICE: 'xtts_last_voice',
  XTTS_LAST_SPEAKER: 'xtts_last_speaker',
  SIMPLE_MODE_INFO_DISMISS: 'storyStudio.simpleModeInfoDismissed',
  BOTTOM_PANEL_HEIGHT: 'bottomPanelHeight',
  MEDIA_EXPLORER_COL_WIDTHS: 'me-col-widths-v2',
  MEDIA_EXPLORER_VISIBLE_COLS: 'me-visible-cols-v2',
});

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
