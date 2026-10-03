// Déroulé de la copie graphe d'un projet par menus, sans React ni disque :
// chaque accès (dialogue, fichier, moteur) est fourni par l'appelant. C'est ce
// qui permet d'éprouver l'ordre des questions et l'absence d'écriture sur
// refus sans monter l'application.

import { isAdvancedProject } from '../store/projectWorkState.js';
import { nextGraphCopyPath } from '../store/graphCopy.js';

export const GRAPH_COPY_TITLE = 'Continuer dans l’éditeur graphe';

function fileLabel(path) {
  return String(path ?? '').split(/[\\/]/).pop();
}

function graphCopyWarning(copyPath) {
  return `Story Studio va créer une copie de ton projet pour l’éditeur graphe : « ${fileLabel(copyPath)} », `
    + 'à côté de l’original. Ton projet reste tel quel. '
    + 'La copie graphe ne pourra pas forcément revenir dans l’éditeur d’origine.';
}

export const SAVE_ORIGINAL_FIRST =
  'Enregistre d’abord ton projet : la copie graphe sera créée à côté de lui.';

/**
 * @param {Object} deps
 * @param {() => Object}   deps.currentProject   le projet à l'écran
 * @param {() => ?string}  deps.currentSavePath  son fichier, s'il en a un
 * @param {() => Promise<?string>} deps.saveOriginal  l'enregistrement habituel
 * @param {(onSave) => Promise<boolean>} deps.confirmLeaveOriginal  la question
 *   « enregistrer les modifications ? » posée pour l'original
 * @param {(dialog) => Promise<*>} deps.choose  dialogue à choix
 * @param {(dialog) => void} deps.showError
 * @param {(path) => Promise<boolean>} deps.fileExists
 * @param {(original) => Promise<Object>} deps.buildCopy  copie complète, garde comprise
 * @param {(project, path) => Promise<void>} deps.writeNewFile  écriture sans écrasement
 * @param {(path) => Promise<void>} deps.openCopy  ouverture dans le graphe
 */
export function createGraphCopyFlow(deps) {
  async function confirmCopy(copyPath) {
    const choice = await deps.choose({
      title: GRAPH_COPY_TITLE,
      message: graphCopyWarning(copyPath),
      variant: 'info',
      cancelValue: null,
      actions: [
        { value: null, label: 'Annuler', kind: 'ghost' },
        { value: 'copy', label: 'Créer la copie', kind: 'primary', autoFocus: true },
      ],
    });
    return choice === 'copy';
  }

  // Un projet jamais enregistré garde ses médias dans le dossier temporaire
  // de la session : la copie doit désigner des fichiers durables. L'original
  // est donc d'abord enregistré, par l'enregistrement habituel.
  async function ensureOriginalSaved() {
    const current = deps.currentSavePath();
    if (current) return current;
    const choice = await deps.choose({
      title: GRAPH_COPY_TITLE,
      message: SAVE_ORIGINAL_FIRST,
      variant: 'info',
      cancelValue: null,
      actions: [
        { value: null, label: 'Annuler', kind: 'ghost' },
        { value: 'save', label: 'Enregistrer le projet', kind: 'primary', autoFocus: true },
      ],
    });
    if (choice !== 'save') return null;
    return (await deps.saveOriginal()) || null;
  }

  // Tout ce qui peut refuser — moteur, disposition, garde — passe avant
  // l'écriture. Une copie écrite qui ne s'ouvre pas est signalée comme telle.
  async function writeAndOpen(original, copyPath) {
    let written = false;
    try {
      const copy = await deps.buildCopy(original);
      await deps.writeNewFile(copy, copyPath);
      written = true;
      await deps.openCopy(copyPath);
      return true;
    } catch (error) {
      const detail = String(error?.message ?? error);
      deps.showError({
        title: GRAPH_COPY_TITLE,
        message: written
          ? `La copie a été créée (${fileLabel(copyPath)}), mais elle n’a pas pu s’ouvrir :\n${detail}`
          : detail,
      });
      return false;
    }
  }

  async function continueInGraph() {
    if (isAdvancedProject(deps.currentProject())) return false;
    const savePath = await ensureOriginalSaved();
    if (!savePath) return false;
    const copyPath = await nextGraphCopyPath(savePath, deps.fileExists);
    if (!(await confirmCopy(copyPath))) return false;
    // La copie reprend ce qui est à l'écran ; l'original reçoit la question
    // habituelle s'il porte des modifications non enregistrées.
    if (!(await deps.confirmLeaveOriginal(deps.saveOriginal))) return false;
    return writeAndOpen(deps.currentProject(), copyPath);
  }

  /**
   * Rend `true` quand il a pris en charge le projet relu : un projet par
   * menus ouvert depuis le graphe devient une proposition de copie, jamais un
   * changement d'éditeur.
   */
  async function routeLoadedProject(result) {
    if (!isAdvancedProject(deps.currentProject()) || isAdvancedProject(result?.data)) return false;
    const copyPath = await nextGraphCopyPath(result.path, deps.fileExists);
    if (await confirmCopy(copyPath)) await writeAndOpen(result.data, copyPath);
    return true;
  }

  return { continueInGraph, routeLoadedProject };
}
