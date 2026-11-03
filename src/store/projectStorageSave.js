import { isFallbackProjectName } from './projectSaveName.js';
import { basenameNoExt, isPathInside, joinPath, stripWindowsLongPathPrefix } from '../utils/fileUtils.js';
import { mapProjectMediaPaths } from './projectMediaPaths.js';
import { sanitizeProjectFolder } from './projectStorage.js';
import { lockProjectMediaStorage, publishProjectMediaStorage } from './projectMediaOutput.js';

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}
export function remapStoragePath(path, moves) {
  if (typeof path !== 'string') return path;
  for (const { from, to } of moves) {
    if (!isPathInside(path, from)) continue;
    const portable = stripWindowsLongPathPrefix(path).replace(/\\/g, '/');
    const prefix = stripWindowsLongPathPrefix(from).replace(/\\/g, '/').replace(/\/+$/, '');
    const components = prefix.split('/').filter(Boolean).length;
    const tail = portable.split('/').filter(Boolean).slice(components).join('/');
    return joinPath(to, tail);
  }
  return path;
}
export function relocateStorageProject(project, moves, storage) {
  return { ...mapProjectMediaPaths(project, (path) => remapStoragePath(path, moves)), storage };
}
export function relocateStorageTags(tags, moves) {
  const result = {};
  for (const [path, values] of Object.entries(tags ?? {})) {
    const target = remapStoragePath(path, moves);
    result[target] = [...new Set([...(result[target] ?? []), ...values])];
  }
  return result;
}
export async function prepareProjectStorageSave({ project, root, path = '', silent = false, ephemeral = false, invokeCommand = invokeTauri }) {
  const unchanged = { project, finalized: false, deferred: false, moves: [], mediaContext: null, commit() {}, async rollback() {}, release() {} };
  if (silent || !project.storage?.provisional) return unchanged;
  const release = lockProjectMediaStorage(project.storage.workId, { allowActive: ephemeral });
  if (!release) return { ...unchanged, deferred: true };
  let moves = []; let old; let folder;
  try {
    const workId = project.storage.workId;
    const desired = sanitizeProjectFolder(!isFallbackProjectName(project.projectName) ? project.projectName : basenameNoExt(path));
    folder = await invokeCommand('resolve_project_folder', { root, folder: desired, workId, create: false });
    if (!ephemeral) {
      old = await invokeCommand('resolve_project_folder', { root, folder: project.storage.folder, workId, create: false });
      moves = await invokeCommand('rename_project_folder', { root, old, new: folder, workId });
    }
    const storage = { ...project.storage, folder: desired, provisional: false };
    return {
      project: relocateStorageProject(project, moves, storage), storage, moves, finalized: true, deferred: false,
      mediaContext: { root, storage, ephemeral: false, saveToken: release.token },
      commit() { publishProjectMediaStorage(storage); },
      async rollback() { if (moves.length) await invokeCommand('rename_project_folder', { root, old: folder, new: old, workId }); },
      release,
    };
  } catch (error) { release(); throw error; }
}
