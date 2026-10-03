import { exists } from '@tauri-apps/plugin-fs';
import { getPackAudioEdgeSilenceSettings } from '../config/audioProcessing.js';
import { buildGraphCopy } from '../store/graphCopy.js';
import { loadProjectFromPath, writeNewProjectFile } from '../store/projectIO.js';
import { logger } from '../utils/logger.js';
import { createGraphCopyFlow } from './graphCopyFlow.js';

/**
 * Passerelle de l'éditeur par menus vers le graphe, par une **copie** : le
 * projet d'origine n'est jamais modifié, la copie « nom - graphe.mbah »
 * s'écrit à côté de lui, puis s'ouvre dans le graphe. Le déroulé vit dans
 * `graphCopyFlow.js` ; ce hook lui fournit le disque, le moteur et les
 * dialogues de l'application.
 */
export function useGraphCopy({
  projectRef,
  savePathRef,
  handleSave,
  confirmSaveBeforeLeaveCurrent,
  applyLoadedProject,
  onBeforeProjectReplaced,
  showChoiceDialog,
  showErrorDialog,
}) {
  return createGraphCopyFlow({
    currentProject: () => projectRef.current,
    currentSavePath: () => savePathRef.current,
    saveOriginal: handleSave,
    confirmLeaveOriginal: confirmSaveBeforeLeaveCurrent,
    choose: showChoiceDialog,
    showError: (dialog) => {
      logger.error(`graph-copy:error ${dialog.message}`);
      showErrorDialog(dialog);
    },
    fileExists: exists,
    buildCopy: (original) => buildGraphCopy(original, {
      audioEdgeSilence: getPackAudioEdgeSilenceSettings(),
    }),
    writeNewFile: writeNewProjectFile,
    openCopy: async (path) => {
      const result = await loadProjectFromPath(path);
      await onBeforeProjectReplaced?.();
      await applyLoadedProject(result);
      logger.info(`graph-copy:opened path='${path}'`);
    },
  });
}
