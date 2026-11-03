import { invoke } from '@tauri-apps/api/core';
import { translateImport } from '../i18n/importPresentation.js';

// Un dossier de pack vaut une archive : il est converti par le lecteur unique
// du moteur (`convert_folder_pack_to_zip`), puis suit le chemin d'un `.zip`.

/** Type réel de chaque chemin (`Map` chemin -> 'folder' | 'file' | 'other'), ou `null` sans moteur. */
export async function readPathKinds(paths) {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length === 0) return new Map();
  try {
    const kinds = await invoke('path_kinds', { paths: list });
    return new Map(list.map((path, index) => [path, kinds?.[index] ?? 'other']));
  } catch {
    // Repli sur le classement par extension : le dépôt n'est pas perdu pour autant,
    // et chaque chemin reste validé par le moteur au moment de son traitement.
    return null;
  }
}

/** Chemin de l'archive produite (cache applicatif) ; rejette avec l'erreur typée du moteur. */
export function convertFolderPackToZip(folderPath) {
  return invoke('convert_folder_pack_to_zip', { folderPath });
}

const parentOf = (path) => String(path).replace(/[\\/][^\\/]*$/, '');

/**
 * Archive d'un dossier de pack rangée dans le projet sous `<nom du dossier>.zip`
 * (nom assaini côté moteur, rendu unique par la copie du projet). `keep(path)`
 * copie le fichier de travail dans le projet et rend le chemin final ; le dossier
 * de travail est libéré ensuite, même en cas d'échec.
 *
 * Les copieurs du projet avalent leurs erreurs et rendent le chemin SOURCE : un
 * chemin encore dans le dossier de travail est donc un échec, signalé par une
 * erreur plutôt que par un nœud qui pointerait sur un fichier supprimé.
 * `apply` affecte le résultat sans rendre la main après le dernier contrôle ;
 * l'appelant garde sa réservation de sortie jusqu'à la fin de cette fonction.
 * Le retrait de la seule copie produite passe par la garde native sans cascade,
 * y compris pour un nom commençant par un point (scopes plugin-fs POSIX).
 */
export async function keepFolderPackInProject(folderPath, keep, {
  call = invoke,
  isCurrent = () => true,
  workspaceDir,
  discard = path => call('delete_workspace_media_file', { path, workspaceDir, cascade: false }),
  apply = null,
} = {}) {
  const staged = await call('convert_folder_pack_to_named_zip', { folderPath });
  const workspace = parentOf(staged);
  let kept = null;
  try {
    if (!isCurrent()) return null;
    kept = await keep(staged);
    if (!kept || parentOf(kept) === workspace) {
      throw new Error(translateImport('import:folder.pack.copy.failed'));
    }
  } finally {
    await Promise.resolve(call('cleanup_session_workspace', { path: workspace })).catch(() => {});
  }
  // Le nettoyage lui-même rend la main : vérifier aussi après cette attente.
  if (!isCurrent()) {
    await discard(kept);
    return null;
  }
  try {
    // Aucun await entre le dernier contrôle et l'affectation au projet.
    apply?.(kept);
  } catch (error) {
    await discard(kept);
    throw error;
  }
  return kept;
}
