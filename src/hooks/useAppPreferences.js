import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { pickWorkspaceDir, consolidateProject, rememberRecentProject } from '../store/projectIO';
import { saveXttsSettings } from '../store/xttsSettings';
import { saveVerboseLoggingPref, verboseLevelName } from '../store/loggingPreference';
import { logger, setLogLevel } from '../utils/logger';
import { isTauriRuntime } from '../utils/tauriRuntime';
import { formatFrenchCount } from '../utils/frenchText.js';
import { collectEndMessagePresentations } from '../store/generatedNavigation';

// Grappe « préférences & réglages » extraite d'AppContent : dossier workspace,
// logging verbeux (+ chemins de log), consolidation projet,
// options globales du pack, message de fin (end node) et réglages XTTS. Ce sont les
// actions qui alimentent la modale de Préférences (OptionsTab asModal) et les
// éditeurs qui consomment onUpdateGlobalOption / onAddEndNode / onRemoveEndNode
// (via ProjectActionsContext).
//
// Couplage assumé au cycle de sauvegarde : handleConsolidateProject pilote l'UI de
// progression via setSaveProgress (qui vient de useSaveProgress, resté dans App.jsx).
// Ce hook la REÇOIT en entrée, il ne recrée pas de progression — il doit donc être
// appelé APRÈS useSaveProgress. sessionMode (useWorkSession) est lu pour ne pas
// écraser le workspace d'une session éphémère.
//
// xttsSettings reste chez l'hôte (lu par la génération, ProjectContext, OptionsTab,
// GenerateVoiceModal) : le hook ne reçoit que setXttsSettings et n'en duplique pas
// l'état. Persistance exclusivement via les helpers dédiés (saveVerboseLoggingPref,
// saveXttsSettings) et readSetting côté hôte, jamais localStorage en direct.
export function useAppPreferences({
  store,
  sessionMode,
  setConfiguredWorkspaceDir,
  setWorkspaceDirState,
  setVerboseLoggingState,
  setSaveProgress,
  setRecentProjects,
  setXttsSettings,
  showErrorDialog,
  showConfirmDialog,
}) {
  async function handlePickWorkspaceDir() {
    const chosen = await pickWorkspaceDir();
    if (chosen) {
      logger.info(`workspace:switched path='${chosen}'`);
      setConfiguredWorkspaceDir(chosen);
      if (sessionMode !== 'ephemeral') {
        setWorkspaceDirState(chosen);
      }
    }
  }

  async function handleVerboseLoggingChange(enabled) {
    setVerboseLoggingState(enabled);
    saveVerboseLoggingPref(enabled);
    const level = verboseLevelName(enabled);
    setLogLevel(level);
    if (isTauriRuntime()) {
      try { await invoke('set_log_level', { level }); }
      catch (err) { logger.error('logging:set-level-error', err); }
    }
    logger.warn(`logging:level-changed level=${level}`);
  }

  function logDirOf(filePath) {
    if (typeof filePath !== 'string' || !filePath) return null;
    return filePath.replace(/[\\/][^\\/]*$/, '') || filePath;
  }

  async function handleResolveLogPath() {
    if (!isTauriRuntime()) return null;
    try {
      const file = await invoke('get_current_log_file');
      return logDirOf(file);
    } catch (err) {
      logger.error('logging:resolve-path-error', err);
      return null;
    }
  }

  async function handleCopyLogPath() {
    if (!isTauriRuntime()) return null;
    try {
      const file = await invoke('get_current_log_file');
      const dir = logDirOf(file);
      if (!dir) return null;
      await navigator.clipboard.writeText(dir);
      return dir;
    } catch (err) {
      logger.error('logging:copy-path-error', err);
      return null;
    }
  }

  async function handleConsolidateProject() {
    const destinationDir = await openDialog({
      directory: true,
      multiple: false,
      title: 'Choisir le dossier de consolidation',
    });
    if (!destinationDir) return null;
    setSaveProgress({ lines: ['Consolidation du projet...'], complete: false });
    try {
      const result = await consolidateProject(store.project, store.savePath, destinationDir, (step) => {
        setSaveProgress(prev => prev ? { ...prev, lines: [...prev.lines, step] } : { lines: [step], complete: false });
      });
      const summary = formatFrenchCount(
        result.copiedCount,
        'fichier copié',
        'fichiers copiés',
      );
      const warnings = result.errors.length > 0
        ? `, ${formatFrenchCount(result.errors.length, 'erreur', 'erreurs')}`
        : '';
      setSaveProgress(prev => prev ? { ...prev, lines: [...prev.lines, `${summary}${warnings}`], complete: true } : null);
      setTimeout(() => setSaveProgress(null), 2200);
      if (result.path && result.project) {
        setRecentProjects(rememberRecentProject(result.project, result.path));
      }
      if (result.errors.length > 0) {
        showErrorDialog({
          title: 'Projet consolidé',
          message: `Projet consolidé avec des fichiers manquants :\n\n${result.errors.slice(0, 5).map((error) => `• ${error.path}\n  ${error.error}`).join('\n')}`,
          variant: 'warning',
        });
      }
      return result;
    } catch (error) {
      setSaveProgress(null);
      showErrorDialog({
        title: 'Consolidation impossible',
        message: `Consolidation impossible : ${error}`,
      });
      return null;
    }
  }

  async function handleUpdateGlobalOption(key, value) {
    store.updateGlobalOption(key, value);
  }

  function handleAddEndNode() {
    store.addGlobalEndMessage();
    store.setSelectedId('end-node');
  }

  async function handleRemoveEndNode(options = {}) {
    const presentations = collectEndMessagePresentations(store.project);
    const globalCount = presentations.filter((item) => item.presentationKind === 'global').length;
    const localCount = presentations.filter((item) => (
      item.presentationKind === 'local_prompt' || item.presentationKind === 'local_sequence'
    )).length;
    if (!options?.skipConfirm) {
      const confirmed = await showConfirmDialog({
        title: 'Supprimer le message de fin',
        message:
          `Le message sera retiré de ${globalCount} histoire${globalCount > 1 ? 's' : ''}. `
          + `${localCount} fin${localCount !== 1 ? 's locales seront' : ' locale sera'} conservée${localCount !== 1 ? 's' : ''}.`,
        variant: 'warning',
        okLabel: 'Supprimer',
        okKind: 'danger',
        cancelLabel: 'Annuler',
      });
      if (!confirmed) return false;
    }

    store.removeGlobalEndMessage();
    return true;
  }

  function handleUpdateXttsSettings(fields) {
    setXttsSettings(prev => {
      const next = { ...prev, ...fields };
      saveXttsSettings(next);
      return next;
    });
  }

  return {
    handlePickWorkspaceDir,
    handleVerboseLoggingChange,
    handleResolveLogPath,
    handleCopyLogPath,
    handleConsolidateProject,
    handleUpdateGlobalOption,
    handleAddEndNode,
    handleRemoveEndNode,
    handleUpdateXttsSettings,
  };
}
