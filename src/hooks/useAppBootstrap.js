import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { getRecentProjects } from '../store/projectIO';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { loadXttsSettings } from '../store/xttsSettings';
import { usePersistentState } from './usePersistentState';
import {
  loadKeyboardShortcuts,
  saveKeyboardShortcuts,
  setCurrentShortcuts,
} from '../store/keyboardShortcuts';
import { applyThemePreference, loadThemePreference, saveThemePreference } from '../store/themePreference';
import { logger, installGlobalErrorHandlers, setLogLevel } from '../utils/logger';
import { loadVerboseLoggingPref, verboseLevelName } from '../store/loggingPreference';
import { isTauriRuntime } from '../utils/tauriRuntime';

// Codecs des `usePersistentState` ci-dessous. BOOL_CODEC existe aussi en copie
// privée dans useBottomWorkspacePanelModel : duplication assumée, un helper
// partagé pour deux consommateurs n'apporterait rien.
const BOOL_CODEC = { decode: (raw) => raw === 'true', encode: (value) => String(!!value) };
const INT_CODEC = {
  decode: (raw) => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  },
  encode: (value) => String(value),
};

// Bootstrap applicatif : version de l'app, préférences globales persistées chargées
// au démarrage, refs synchronisées et effets thème/logging/raccourcis. Ce hook PRÉPARE
// l'app ; il ne porte NI la session, NI la sauvegarde, NI l'import (qui restent
// câblés dans AppContent). L'effet `ensureWorkspaceDir` reste volontairement chez
// l'hôte : il lit `sessionModeRef` qui n'existe qu'après useWorkSession.
// Ne pas ajouter de mémoïsation — rien de calculé par rendu ne doit être figé ici.
export function useAppBootstrap() {
  const [appVersion, setAppVersion] = useState('');
  const [xttsSettings, setXttsSettings] = useState(() => loadXttsSettings());
  const [keyboardShortcuts, setKeyboardShortcuts] = useState(() => loadKeyboardShortcuts());
  const [themePreference, setThemePreference] = useState(() => loadThemePreference());
  const [recentProjects, setRecentProjects] = useState(() => getRecentProjects());
  const [copyImportedFilesEnabled, setCopyImportedFilesEnabled] = usePersistentState(KEYS.COPY_FILES, false, BOOL_CODEC);
  const [configuredWorkspaceDir, setConfiguredWorkspaceDir] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [workspaceDir, setWorkspaceDirState] = useState(() => readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const [useWorkspaceForNewProjects, setUseWorkspaceForNewProjects] = usePersistentState(KEYS.USE_WORKSPACE_FOR_NEW_PROJECTS, false, BOOL_CODEC);
  // Actif par défaut ; la migration one-shot de main.jsx aligne les installations existantes.
  const [autoSaveEnabled, setAutoSaveEnabled] = usePersistentState(KEYS.AUTOSAVE_ENABLED, true, BOOL_CODEC);
  const [autoSaveBackupLimit, setAutoSaveBackupLimit] = usePersistentState(KEYS.AUTOSAVE_BACKUP_LIMIT, 5, INT_CODEC);
  const [verboseLogging, setVerboseLoggingState] = useState(() => loadVerboseLoggingPref());

  const workspaceDirRef = useRef(readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }));
  const keyboardShortcutsRef = useRef(keyboardShortcuts);
  const dismissedTransferPromptRef = useRef(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  useEffect(() => {
    const detach = installGlobalErrorHandlers();
    const verbose = loadVerboseLoggingPref();
    const level = verboseLevelName(verbose);
    setLogLevel(level);
    if (isTauriRuntime()) {
      invoke('set_log_level', { level })
        .then(() => {
          logger.info(`boot:verbose-enabled value=${verbose} runtime=tauri ua=${navigator.userAgent.slice(0, 80)}`);
        })
        .catch(() => {});
    }
    return detach;
  }, []);

  useEffect(() => {
    workspaceDirRef.current = workspaceDir;
  }, [workspaceDir]);

  useEffect(() => {
    keyboardShortcutsRef.current = keyboardShortcuts;
    setCurrentShortcuts(keyboardShortcuts);
    saveKeyboardShortcuts(keyboardShortcuts);
  }, [keyboardShortcuts]);

  useEffect(() => {
    const cleanup = applyThemePreference(themePreference);
    saveThemePreference(themePreference);
    return cleanup;
  }, [themePreference]);

  useEffect(() => {
    if (!copyImportedFilesEnabled) dismissedTransferPromptRef.current = null;
  }, [copyImportedFilesEnabled]);

  return {
    appVersion,
    xttsSettings,
    setXttsSettings,
    keyboardShortcuts,
    setKeyboardShortcuts,
    keyboardShortcutsRef,
    themePreference,
    setThemePreference,
    recentProjects,
    setRecentProjects,
    copyImportedFilesEnabled,
    setCopyImportedFilesEnabled,
    configuredWorkspaceDir,
    setConfiguredWorkspaceDir,
    workspaceDir,
    setWorkspaceDirState,
    workspaceDirRef,
    useWorkspaceForNewProjects,
    setUseWorkspaceForNewProjects,
    autoSaveEnabled,
    setAutoSaveEnabled,
    autoSaveBackupLimit,
    setAutoSaveBackupLimit,
    verboseLogging,
    setVerboseLoggingState,
    dismissedTransferPromptRef,
  };
}
