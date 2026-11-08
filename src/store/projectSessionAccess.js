// Native claims guard editor access against pending catalogue publications.
import { isTauri } from '@tauri-apps/api/core';
import { catalogueFilesApi } from './catalogue/catalogueFilesApi.js';
let active = null;
let modified = true;
let pendingState = Promise.resolve();
export function setActiveProjectModified(value) { modified = value; }
export async function syncActiveProjectAccess() {
  const token = active;
  const action = modified ? 'modified' : 'saved';
  if (!token) return;
  pendingState = pendingState.catch(() => {}).then(() => catalogueFilesApi.projectAccess(action, null, token));
  await pendingState;
}
export async function releaseActiveProjectAccess() {
  const token = active; active = null;
  if (token) await catalogueFilesApi.projectAccess('release', null, token);
}
export async function installProjectAccess(token, project = null, accept = () => true) {
  try {
    if (token && project?.storage?.workId) await catalogueFilesApi.projectAccess('bind', null, token, project.storage.workId);
  } catch (error) {
    await releaseProjectAccess(token).catch(() => {});
    throw error;
  }
  if (!accept()) { await releaseProjectAccess(token); return; }
  const previous = active; active = token ?? null;
  if (previous && previous !== token) await catalogueFilesApi.projectAccess('release', null, previous);
  // Native claims start modified, so only a clean editor needs an update here.
  // Its work-state effect may have run before this claim was installed; publish
  // the saved state now so an already queued send can use it.
  if (!modified) await syncActiveProjectAccess();
}
export async function claimProjectAccess(kind, path) {
  if (!isTauri()) return null;
  try { return (await catalogueFilesApi.projectAccess(kind, path)).token; }
  catch (error) {
    // Admission is latched until restart. No catalogue writer or file operation
    // can run in this process. Writer-lock contention is rejected by the boot gate.
    if (error?.code === 'CATALOG_STORE_UNAVAILABLE') return null;
    throw error;
  }
}
export async function withProjectSaveAccess(path, save) {
  const token = await claimProjectAccess('save', path);
  try { return await save(); }
  finally { if (token) await catalogueFilesApi.projectAccess('release', null, token); }
}

export async function releaseProjectAccess(token) { if (token) await catalogueFilesApi.projectAccess('release', null, token); }
