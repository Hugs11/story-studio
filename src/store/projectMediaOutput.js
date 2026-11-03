import { joinPath } from '../utils/fileUtils.js';
import { PROJECT_MEDIA_CATEGORIES } from './projectStorage.js';
import { importPresentationError } from '../i18n/importPresentation.js';

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(command, args);
}
const active = new Map();
const locks = new Map();
const finalized = new Map();
const jobOutputs = new Map();

export function isProjectMediaOutputBusy(workId) { return (active.get(workId) ?? 0) > 0; }
export function lockProjectMediaStorage(workId, { allowActive = false } = {}) {
  if ((!allowActive && isProjectMediaOutputBusy(workId)) || locks.has(workId)) return null;
  const token = {};
  locks.set(workId, token);
  const release = () => { if (locks.get(workId) === token) locks.delete(workId); };
  release.token = token;
  return release;
}
export function publishProjectMediaStorage(storage) { finalized.set(storage.workId, storage); }

// Acquire before the first await; callers hold this reservation for the entire
// write, including queued jobs. The root and work identity never follow renders.
export function beginProjectMediaOutput(context, { invokeCommand = invokeTauri } = {}) {
  const root = String(context?.root ?? '').trim();
  const storage = finalized.get(context?.storage?.workId) ?? context?.storage;
  const workId = storage?.workId;
  const ephemeral = context?.ephemeral;
  // Refus codés : message résolu dans la langue active à la lecture.
  if (!root) throw importPresentationError('media:output.workspace.missing', {}, { code: 'MEDIA_OUTPUT_WORKSPACE_MISSING' });
  if (workId && locks.has(workId) && locks.get(workId) !== context?.saveToken) throw importPresentationError('media:output.project.locked', {}, { code: 'MEDIA_OUTPUT_PROJECT_LOCKED' });
  if (workId) active.set(workId, (active.get(workId) ?? 0) + 1);
  let released = false;
  let resolved = null;
  const destination = () => {
    if (!resolved) {
      resolved = !ephemeral && storage
        ? invokeCommand('resolve_project_folder', { root, folder: storage.folder, workId, create: true })
          .then((folder) => ({ folder, workId }))
        : Promise.resolve(null);
    }
    return resolved;
  };
  return {
    async directory(category) {
      if (!PROJECT_MEDIA_CATEGORIES.includes(category)) throw importPresentationError('media:output.category.invalid', {}, { code: 'MEDIA_OUTPUT_CATEGORY_INVALID' });
      const projectDestination = await destination();
      return joinPath(root, category, ...(projectDestination ? [projectDestination.folder] : []));
    },
    async arguments() { return { workspaceDir: root, projectDestination: await destination() }; },
    release() {
      if (released) return;
      released = true;
      if (workId) { const count = active.get(workId) - 1; if (count) active.set(workId, count); else active.delete(workId); }
    },
  };
}

export async function withProjectMediaOutput(context, run, options) {
  const output = beginProjectMediaOutput(context, options);
  try { return await run(output); } finally { output.release(); }
}

export async function captureProjectMediaJob(context) {
  const output = beginProjectMediaOutput(context);
  try {
    const args = await output.arguments();
    const outputId = crypto.randomUUID();
    jobOutputs.set(outputId, output);
    return { ...args, outputId, workId: context?.storage?.workId };
  } catch (error) { output.release(); throw error; }
}
export function releaseProjectMediaJob(job) {
  const id = job?.mediaOutput?.outputId;
  jobOutputs.get(id)?.release(); jobOutputs.delete(id);
}
