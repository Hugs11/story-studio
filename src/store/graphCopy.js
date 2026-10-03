// Copie graphe d'un projet par menus : ce que l'interface décide seule.
//
// Le moteur fabrique le payload et ses liaisons (`copy_project_to_graph`) et
// juge la fidélité (`verify_project_graph_copy`). Ce module ne fait que
// l'autour : le nom du fichier de la copie, ce que son enveloppe reprend de
// l'original, et la disposition calculée avant l'écriture — par les mêmes
// gestes que le rangement de l'atelier, pour que la copie s'ouvre rangée.
//
// Aucune fonction ici n'écrit sur le disque : l'existence d'un fichier est
// une question posée par l'appelant, et l'écriture lui appartient.

import { readPackAudioProcessing } from '../config/audioProcessing.js';
import { archiveNamingFields } from './advancedExport/archiveName.js';
import { layoutEntriesFromPositions } from './advancedAuthoring/graphLinkDraft.js';
import { NO_FOLD, parcoursLayout } from './advancedGraphView/graphParcoursLayout.js';
import { buildGraphIndex } from './advancedGraphView/graphViewModel.js';
import { advancedGestures } from './projectModel/advancedGestures.js';
import { applyAdvancedGesture, createAdvancedProject, readAuthoringPayload } from './projectModel/authoring.js';
import { projectToRustExport } from './projectModel/schema.js';

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}

const GRAPH_COPY_SUFFIX = ' - graphe';
const MAX_GRAPH_COPIES = 999;

function splitProjectPath(savePath) {
  const path = String(savePath ?? '');
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = cut >= 0 ? path.slice(0, cut + 1) : '';
  const name = (cut >= 0 ? path.slice(cut + 1) : path).replace(/\.mbah$/i, '');
  return { dir, name };
}

/** « Toudou - graphe.mbah », puis « Toudou - graphe (2).mbah »… à côté de l'original. */
export function graphCopyFileName(savePath, rank = 1) {
  const { name } = splitProjectPath(savePath);
  return rank <= 1 ? `${name}${GRAPH_COPY_SUFFIX}.mbah` : `${name}${GRAPH_COPY_SUFFIX} (${rank}).mbah`;
}

/**
 * Le premier chemin libre pour la copie. Aucun fichier n'est jamais écrasé :
 * un nom déjà pris passe au suivant.
 */
export async function nextGraphCopyPath(savePath, fileExists) {
  const { dir } = splitProjectPath(savePath);
  for (let rank = 1; rank <= MAX_GRAPH_COPIES; rank += 1) {
    const candidate = `${dir}${graphCopyFileName(savePath, rank)}`;
    if (!(await fileExists(candidate))) return candidate;
  }
  throw new Error('Trop de copies graphe portent déjà ce nom à côté de ton projet.');
}

/**
 * Le projet tel que le moteur le reçoit pour la copie. Le titre du pack est
 * celui de la fiche : le nom d'archive, lui, est recomposé par l'export graphe
 * depuis les champs de nommage que l'enveloppe de la copie reprend.
 */
export function graphCopyRustExport(project, audioEdgeSilence) {
  const exported = projectToRustExport(project, audioEdgeSilence);
  const title = String(project?.packMetadata?.title ?? '').trim()
    || (project?.projectType === 'simple' ? String(project?.projectName ?? '').trim() : '');
  return title ? { ...exported, name: title } : exported;
}

/**
 * L'enveloppe de la copie : ce que le graphe sait garder hors du document.
 * « Même image » côté arbre, c'est l'absence de vignette propre côté graphe.
 */
export function graphCopyProject(original, acquired) {
  const sameImage = !!original?.sameImage || !original?.thumbnailImage;
  return {
    ...createAdvancedProject({
      payload: acquired.payload,
      projectName: original?.projectName ?? '',
      packMetadata: archiveNamingFields(original?.packMetadata ?? {}),
      mediaBindings: acquired.mediaBindings ?? [],
      thumbnailImage: sameImage ? null : original.thumbnailImage,
    }),
    globalOptions: readPackAudioProcessing(original?.globalOptions),
  };
}

/**
 * La disposition calculée avant l'écriture, comme le rangement d'un pack
 * importé : même calcul, mêmes deux gestes. Un nœud à identifiant dupliqué
 * n'est adressable par aucun geste et reste où il est.
 */
async function arrangeGraphCopy(project, { invokeCommand = invokeTauri } = {}) {
  const view = await invokeCommand('read_advanced_graph_view', { payload: readAuthoringPayload(project) });
  const index = buildGraphIndex(view);
  const { positions } = parcoursLayout(index, NO_FOLD);
  const addressable = [...positions]
    .map(([path, position]) => ({ path, ...position }))
    .filter((position) => index.byPath.get(position.path)?.node.uniqueId !== false);
  if (addressable.length === 0) return project;
  const staged = await applyAdvancedGesture(
    project,
    advancedGestures.applyViewLayout(layoutEntriesFromPositions(index, addressable)),
    { invokeCommand },
  );
  const promoted = await applyAdvancedGesture(
    staged.project,
    advancedGestures.applyLayoutToAuthoring([], 'refuse'),
    { invokeCommand },
  );
  return promoted.project;
}

/**
 * La copie complète, prête à écrire : payload du moteur, enveloppe, rangement,
 * puis garde de fidélité sur le payload **final**. Un refus lève, et rien n'a
 * été écrit.
 */
export async function buildGraphCopy(original, { audioEdgeSilence, invokeCommand = invokeTauri } = {}) {
  const projectJson = JSON.stringify(graphCopyRustExport(original, audioEdgeSilence));
  const acquired = await invokeCommand('copy_project_to_graph', { projectJson });
  const arranged = await arrangeGraphCopy(graphCopyProject(original, acquired), { invokeCommand });
  await invokeCommand('verify_project_graph_copy', {
    projectJson,
    payload: readAuthoringPayload(arranged),
  });
  return arranged;
}
