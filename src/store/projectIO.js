import { open, save } from '@tauri-apps/plugin-dialog';
import { documentDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, copyFile, mkdir, rename, remove, exists, readDir } from '@tauri-apps/plugin-fs';
import { getProjectFilePrefix, sanitizeProjectPrefix } from '../utils/projectPrefix';
import { TEMP_IMAGES_DIR, LEGACY_TEMP_IMAGES_DIR } from '../utils/tempDirs';
import { migrateProjectData, normalizeProjectData, projectToRustExport, projectToSerializable, visitProjectEntries } from './projectModel';

const PROJECT_OPEN_KEYS = ['lastOpenProjectDir', 'lastProjectDir'];
const PROJECT_SAVE_KEYS = ['lastSaveProjectDir', 'lastProjectDir'];
const RECENT_PROJECTS_KEY = 'recentProjects';
const WORKSPACE_DIR_KEY = 'storyStudioWorkspaceDir';
const MANAGED_PROJECT_DIRS = ['fichiers-importes', 'enregistrements', 'voix-generees', 'images-generees', 'zips-extraits', 'exports'];
const RECENT_PROJECT_LIMIT = 8;
const BACKUP_DIR_NAME = '.story-studio-backups';
const AUTOSAVE_DIR_NAME = 'sauvegardes';
const AUTOSAVE_BACKUP_DIR_NAME = 'versions-securite';

function getStoredDir(keys) {
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value) return value;
  }
  return undefined;
}

function saveProjectDir(key, filePath) {
  if (!filePath) return;
  const dir = filePath.replace(/[\\/][^\\/]+$/, '');
  if (dir) localStorage.setItem(key, dir);
}

export async function getDefaultWorkspaceDir() {
  const docs = await documentDir();
  return join(docs, 'story-studio');
}

export async function getWorkspaceDir() {
  const saved = localStorage.getItem(WORKSPACE_DIR_KEY);
  if (saved?.trim()) return saved;
  const fallback = await getDefaultWorkspaceDir();
  localStorage.setItem(WORKSPACE_DIR_KEY, fallback);
  return fallback;
}

export function setWorkspaceDir(path) {
  if (path?.trim()) localStorage.setItem(WORKSPACE_DIR_KEY, path);
}

export async function pickWorkspaceDir() {
  const current = await getWorkspaceDir();
  const chosen = await open({
    directory: true,
    multiple: false,
    defaultPath: current,
    title: 'Choisir l’emplacement de travail',
  });
  if (!chosen) return null;
  setWorkspaceDir(chosen);
  await mkdir(chosen, { recursive: true });
  return chosen;
}

function basenameWithoutExtension(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/.*\//, '')
    .replace(/\.[^/.]+$/, '');
}

function projectNameFromPath(path) {
  return basenameWithoutExtension(path).trim();
}

function isFallbackProjectName(value) {
  const normalized = String(value || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase();
  return !normalized || ['nouveau-projet', 'nouveau projet', 'mon-projet', 'mon projet', 'projet'].includes(normalized);
}

function withLocalProjectNameForPath(project, path, { force = false } = {}) {
  const stem = projectNameFromPath(path);
  if (!stem) return project;
  if (!force && !isFallbackProjectName(project?.projectName)) return project;
  return { ...project, projectName: stem };
}

export function getRecentProjects() {
  try {
    const raw = localStorage.getItem(RECENT_PROJECTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim());
  } catch {
    return [];
  }
}

export function rememberRecentProject(project, path) {
  if (!path) return [];
  const existing = getRecentProjects();
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const nextEntry = {
    path,
    projectName: project?.projectName?.trim() || basenameWithoutExtension(path) || 'Projet sans nom',
    name: project?.projectName?.trim() || basenameWithoutExtension(path) || 'Projet sans nom',
    projectType: project?.projectType || 'pack',
    updatedAt: Date.now(),
  };
  const next = [
    nextEntry,
    ...existing.filter((entry) => entry.path.replace(/\\/g, '/').toLowerCase() !== normalizedPath),
  ].slice(0, RECENT_PROJECT_LIMIT);
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
  return next;
}

export function forgetRecentProject(path) {
  if (!path) return getRecentProjects();
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const next = getRecentProjects()
    .filter((entry) => entry.path.replace(/\\/g, '/').toLowerCase() !== normalizedPath);
  localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(next));
  return next;
}

/** Détecte si un chemin est une image temporaire produite par Story Studio */
function isTempImage(path) {
  if (typeof path !== 'string') return false;
  const normalized = path.replace(/\\/g, '/');
  return normalized.includes(`/${TEMP_IMAGES_DIR}/`)
    || normalized.includes(`/${LEGACY_TEMP_IMAGES_DIR}/`);
}

function hasPath(path) {
  return typeof path === 'string' && path.trim().length > 0;
}

function normalizePath(path) {
  return String(path || '')
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase();
}

function getProjectDir(savePath) {
  return savePath.replace(/[\\/][^\\/]+$/, '');
}

function getFileName(path) {
  return String(path || '').replace(/\\/g, '/').replace(/.*\//, '');
}

function splitFileName(fileName) {
  const match = String(fileName || '').match(/^(.*?)(\.[^.]*)?$/);
  return {
    stem: match?.[1] || 'asset',
    ext: match?.[2] || '',
  };
}

function getProjectAssetsDir(savePath) {
  const projectDir = getProjectDir(savePath);
  const projectBaseName = savePath.replace(/.*[\\/]/, '').replace(/\.mbah$/i, '');
  return `${projectDir}/${projectBaseName}_assets`;
}

function isPathInsideDir(path, dir) {
  const normalizedPath = normalizePath(path);
  const normalizedDir = normalizePath(dir);
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
}

function relativizeTagKeys(tags, mbahDir) {
  if (!tags || typeof tags !== 'object') return {};
  const result = {};
  for (const [path, tagList] of Object.entries(tags)) {
    if (Array.isArray(tagList) && tagList.length > 0) {
      result[toProjectRelative(path, mbahDir)] = tagList;
    }
  }
  return result;
}

function absolutizeTagKeys(tags, mbahDir) {
  if (!tags || typeof tags !== 'object') return {};
  const result = {};
  for (const [path, tagList] of Object.entries(tags)) {
    if (Array.isArray(tagList) && tagList.length > 0) {
      result[fromProjectRelative(path, mbahDir)] = tagList;
    }
  }
  return result;
}

// Converts an absolute path to a relative path (./...) if it's inside mbahDir, otherwise returns it unchanged.
function toProjectRelative(absolutePath, mbahDir) {
  if (!hasPath(absolutePath)) return absolutePath;
  const fwdPath = absolutePath.replace(/\\/g, '/');
  const fwdDir = mbahDir.replace(/\\/g, '/').replace(/\/$/, '');
  if (!fwdPath.toLowerCase().startsWith(fwdDir.toLowerCase() + '/')) return absolutePath;
  return './' + fwdPath.slice(fwdDir.length + 1);
}

// Resolves a relative path (./...) against mbahDir into an absolute path.
// Absolute paths (old projects) are returned unchanged.
function fromProjectRelative(maybRelativePath, mbahDir) {
  if (!hasPath(maybRelativePath)) return maybRelativePath;
  if (!maybRelativePath.startsWith('./') && !maybRelativePath.startsWith('../')) return maybRelativePath;
  const fwdDir = mbahDir.replace(/\\/g, '/').replace(/\/$/, '');
  return fwdDir + '/' + maybRelativePath.replace(/^\.\//, '');
}

// Walks all path fields in a project and applies transformFn to each non-empty path.
function mapProjectPaths(project, transformFn) {
  const cloned = JSON.parse(JSON.stringify(project));
  const t = (p) => (hasPath(p) ? transformFn(p) : p);
  cloned.rootAudio = t(cloned.rootAudio);
  cloned.rootImage = t(cloned.rootImage);
  cloned.thumbnailImage = t(cloned.thumbnailImage);
  cloned.nightModeAudio = t(cloned.nightModeAudio);
  const mapNativeGraph = (graph) => {
    for (const stage of graph?.document?.stageNodes ?? []) {
      stage.audio = t(stage.audio);
      stage.image = t(stage.image);
    }
  };
  mapNativeGraph(cloned.nativeGraph);
  visitProjectEntries(cloned, (entry) => {
    if (entry.type === 'menu') {
      entry.audio = t(entry.audio);
      entry.image = t(entry.image);
      mapNativeGraph(entry.nativeGraph);
    } else if (entry.type === 'zip') {
      entry.zipPath = t(entry.zipPath);
    } else {
      entry.audio = t(entry.audio);
      entry.image = t(entry.image);
      entry.itemAudio = t(entry.itemAudio);
      entry.itemImage = t(entry.itemImage);
      entry.afterPlaybackPromptAudio = t(entry.afterPlaybackPromptAudio);
      for (const step of entry.afterPlaybackSequence ?? []) {
        step.audio = t(step.audio);
        step.image = t(step.image);
      }
      if (entry.afterPlaybackHomeStep) {
        entry.afterPlaybackHomeStep.audio = t(entry.afterPlaybackHomeStep.audio);
        entry.afterPlaybackHomeStep.image = t(entry.afterPlaybackHomeStep.image);
      }
    }
  });
  return cloned;
}

function isManagedProjectPath(path, savePath) {
  if (!hasPath(path) || !hasPath(savePath)) return false;
  const workspaceDir = localStorage.getItem(WORKSPACE_DIR_KEY);
  if (isManagedWorkspacePath(path, workspaceDir)) return true;
  const projectDir = getProjectDir(savePath);
  if (isPathInsideDir(path, projectDir)) return true;
  if (isPathInsideDir(path, getProjectAssetsDir(savePath))) return true;
  return MANAGED_PROJECT_DIRS.some((dirName) => isPathInsideDir(path, `${projectDir}/${dirName}`));
}

function isManagedWorkspacePath(path, workspaceDir) {
  if (!hasPath(path) || !hasPath(workspaceDir)) return false;
  return MANAGED_PROJECT_DIRS.some((dirName) => isPathInsideDir(path, `${workspaceDir}/${dirName}`));
}

function shouldTransferProjectPath(path, savePath, statusByPath = null) {
  if (!hasPath(path) || !hasPath(savePath)) return false;
  if (statusByPath?.[path] === false) return false;
  if (isTempImage(path)) return false;
  return !isManagedProjectPath(path, savePath);
}

function pushTransferCandidate(candidates, seen, path, label, savePath, statusByPath) {
  if (!shouldTransferProjectPath(path, savePath, statusByPath)) return;
  const key = normalizePath(path);
  if (seen.has(key)) return;
  seen.add(key);
  candidates.push({
    path,
    label,
    filename: path.split(/[\\/]/).pop() || path,
  });
}

function collectTransferTargets(project, savePath, statusByPath = null) {
  const updated = JSON.parse(JSON.stringify(projectToSerializable(normalizeProjectData(project))));
  const refs = [];

  const addRef = (obj, key, label) => {
    const path = obj?.[key];
    if (!shouldTransferProjectPath(path, savePath, statusByPath)) return;
    refs.push({ obj, key, path, label });
  };

  addRef(updated, 'rootAudio', 'Audio de couverture');
  addRef(updated, 'rootImage', 'Image de couverture');
  addRef(updated, 'thumbnailImage', 'Image bibliothèque');
  addRef(updated, 'nightModeAudio', 'Audio mode nuit');
  for (const stage of updated.nativeGraph?.document?.stageNodes ?? []) {
    addRef(stage, 'audio', `Audio graphe natif: ${stage.name || stage.uuid || 'stage'}`);
    addRef(stage, 'image', `Image graphe natif: ${stage.name || stage.uuid || 'stage'}`);
  }

  visitProjectEntries(updated, (entry) => {
    if (entry?.type === 'menu') {
      addRef(entry, 'audio', `Audio menu: ${entry.name || 'sans nom'}`);
      addRef(entry, 'image', `Image menu: ${entry.name || 'sans nom'}`);
      for (const stage of entry.nativeGraph?.document?.stageNodes ?? []) {
        addRef(stage, 'audio', `Audio graphe natif: ${stage.name || stage.uuid || 'stage'}`);
        addRef(stage, 'image', `Image graphe natif: ${stage.name || stage.uuid || 'stage'}`);
      }
      return;
    }
    if (entry?.type === 'zip') {
      addRef(entry, 'zipPath', `ZIP: ${entry.name || 'sans nom'}`);
      return;
    }
    addRef(entry, 'audio', `Audio histoire: ${entry.name || 'sans nom'}`);
    addRef(entry, 'itemAudio', `Titre audio: ${entry.name || 'sans nom'}`);
    addRef(entry, 'afterPlaybackPromptAudio', `Audio fin histoire: ${entry.name || 'sans nom'}`);
    for (const [index, step] of (entry.afterPlaybackSequence ?? []).entries()) {
      addRef(step, 'audio', `Audio fin histoire ${index + 1}: ${entry.name || 'sans nom'}`);
      addRef(step, 'image', `Image fin histoire ${index + 1}: ${entry.name || 'sans nom'}`);
    }
    addRef(entry.afterPlaybackHomeStep, 'audio', `Audio fin histoire home: ${entry.name || 'sans nom'}`);
    addRef(entry.afterPlaybackHomeStep, 'image', `Image fin histoire home: ${entry.name || 'sans nom'}`);
    addRef(entry, 'itemImage', `Image histoire: ${entry.name || 'sans nom'}`);
  });

  return { updated, refs };
}

export function collectTransferableProjectFiles(project, savePath, statusByPath = null) {
  if (!hasPath(savePath)) return [];
  const normalized = normalizeProjectData(project);
  const candidates = [];
  const seen = new Set();

  pushTransferCandidate(candidates, seen, normalized.rootAudio, 'Audio de couverture', savePath, statusByPath);
  pushTransferCandidate(candidates, seen, normalized.rootImage, 'Image de couverture', savePath, statusByPath);
  pushTransferCandidate(candidates, seen, normalized.thumbnailImage, 'Image bibliothèque', savePath, statusByPath);
  pushTransferCandidate(candidates, seen, normalized.nightModeAudio, 'Audio mode nuit', savePath, statusByPath);
  const pushNativeGraphCandidates = (graph) => {
    for (const stage of graph?.document?.stageNodes ?? []) {
      pushTransferCandidate(candidates, seen, stage.audio, `Audio graphe natif: ${stage.name || stage.uuid || 'stage'}`, savePath, statusByPath);
      pushTransferCandidate(candidates, seen, stage.image, `Image graphe natif: ${stage.name || stage.uuid || 'stage'}`, savePath, statusByPath);
    }
  };
  pushNativeGraphCandidates(normalized.nativeGraph);

  visitProjectEntries(normalized, (entry) => {
    if (entry?.type === 'menu') {
      pushTransferCandidate(candidates, seen, entry.audio, `Audio menu: ${entry.name || 'sans nom'}`, savePath, statusByPath);
      pushTransferCandidate(candidates, seen, entry.image, `Image menu: ${entry.name || 'sans nom'}`, savePath, statusByPath);
      pushNativeGraphCandidates(entry.nativeGraph);
      return;
    }
    if (entry?.type === 'zip') {
      pushTransferCandidate(candidates, seen, entry.zipPath, `ZIP: ${entry.name || 'sans nom'}`, savePath, statusByPath);
      return;
    }
    pushTransferCandidate(candidates, seen, entry.audio, `Audio histoire: ${entry.name || 'sans nom'}`, savePath, statusByPath);
    pushTransferCandidate(candidates, seen, entry.itemAudio, `Titre audio: ${entry.name || 'sans nom'}`, savePath, statusByPath);
    pushTransferCandidate(candidates, seen, entry.afterPlaybackPromptAudio, `Audio fin histoire: ${entry.name || 'sans nom'}`, savePath, statusByPath);
    for (const [index, step] of (entry.afterPlaybackSequence ?? []).entries()) {
      pushTransferCandidate(candidates, seen, step.audio, `Audio fin histoire ${index + 1}: ${entry.name || 'sans nom'}`, savePath, statusByPath);
      pushTransferCandidate(candidates, seen, step.image, `Image fin histoire ${index + 1}: ${entry.name || 'sans nom'}`, savePath, statusByPath);
    }
    pushTransferCandidate(candidates, seen, entry.afterPlaybackHomeStep?.audio, `Audio fin histoire home: ${entry.name || 'sans nom'}`, savePath, statusByPath);
    pushTransferCandidate(candidates, seen, entry.afterPlaybackHomeStep?.image, `Image fin histoire home: ${entry.name || 'sans nom'}`, savePath, statusByPath);
    pushTransferCandidate(candidates, seen, entry.itemImage, `Image histoire: ${entry.name || 'sans nom'}`, savePath, statusByPath);
  });

  return candidates;
}

export async function transferProjectFilesToProject(project, savePath, copyToProject, statusByPath = null) {
  const { updated, refs } = collectTransferTargets(project, savePath, statusByPath);
  if (refs.length === 0) {
    return { project: updated, copiedCount: 0, errors: [] };
  }

  const copiedPaths = new Map();
  const errors = [];

  for (const ref of refs) {
    const cacheKey = normalizePath(ref.path);
    let nextPath = copiedPaths.get(cacheKey);

    if (!nextPath) {
      try {
        nextPath = await copyToProject(ref.path, savePath);
        copiedPaths.set(cacheKey, nextPath);
      } catch (error) {
        errors.push({
          path: ref.path,
          label: ref.label,
          error: String(error),
        });
        continue;
      }
    }

    ref.obj[ref.key] = nextPath;
  }

  return {
    project: updated,
    copiedCount: copiedPaths.size,
    errors,
  };
}

export { projectToRustExport };

async function uniquePathInDir(dir, fileName) {
  let candidate = `${dir}/${fileName}`;
  if (!(await exists(candidate))) return candidate;
  const { stem, ext } = splitFileName(fileName);
  for (let index = 1; index < 1000; index += 1) {
    candidate = `${dir}/${stem}--${Date.now()}-${index}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Impossible de créer un nom unique pour ${fileName}`);
}

async function backupProjectFile(path, limit = 0, backupDirOverride = null) {
  const keep = Number(limit) || 0;
  if (keep <= 0 || !path || !(await exists(path))) return;
  const projectDir = getProjectDir(path);
  const baseName = getFileName(path).replace(/\.mbah$/i, '');
  const backupDir = backupDirOverride ?? `${projectDir}/${BACKUP_DIR_NAME}`;
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(path, `${backupDir}/${baseName}.${stamp}.mbah`);

  const entries = await readDir(backupDir).catch(() => []);
  const backups = entries
    .filter((entry) => entry.isFile && entry.name?.startsWith(`${baseName}.`) && entry.name.endsWith('.mbah'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const stale of backups.slice(keep)) {
    await remove(`${backupDir}/${stale}`).catch(() => {});
  }
}

async function writeProjectFileAtomic(path, contents, { backupLimit = 0, backupDirOverride = null } = {}) {
  await backupProjectFile(path, backupLimit, backupDirOverride);
  const tmpPath = `${path}.tmp-${Date.now()}`;
  await writeTextFile(tmpPath, contents);
  try {
    await rename(tmpPath, path);
  } catch (error) {
    await remove(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Copie les images temporaires vers {workspaceDir}/images-generees/.
 * Fallback : images-generees/ à côté du .mbah si workspace non défini.
 * Retourne un projet avec les chemins mis à jour.
 */
async function persistTempImages(project, projectPath, workspaceDir = null) {
  const normalized = normalizeProjectData(project);
  const projectBaseName = projectPath.replace(/.*[\\/]/, '').replace(/\.mbah$/, '');

  // Collecte des images temporaires
  const collect = [];
  if (isTempImage(normalized.rootImage)) collect.push({ obj: normalized, key: 'rootImage' });
  if (isTempImage(normalized.thumbnailImage)) collect.push({ obj: normalized, key: 'thumbnailImage' });
  visitProjectEntries(normalized, (entry) => {
    if (entry?.type === 'menu' && isTempImage(entry.image)) collect.push({ obj: entry, key: 'image' });
    if (entry?.type === 'story' && isTempImage(entry.itemImage)) collect.push({ obj: entry, key: 'itemImage' });
  });

  if (collect.length === 0) return projectToSerializable(normalized);

  const resolvedWs = workspaceDir || localStorage.getItem(WORKSPACE_DIR_KEY) || null;
  const baseDir = resolvedWs || projectPath.replace(/[\\/][^\\/]+$/, '');
  const targetDir = `${baseDir}/images-generees`;

  await mkdir(targetDir, { recursive: true });

  // Clone profond pour ne pas muter le store
  const updated = JSON.parse(JSON.stringify(projectToSerializable(normalized)));

  const cloneCollect = [];
  if (isTempImage(updated.rootImage))      cloneCollect.push({ obj: updated, key: 'rootImage' });
  if (isTempImage(updated.thumbnailImage)) cloneCollect.push({ obj: updated, key: 'thumbnailImage' });
  visitProjectEntries(updated, (entry) => {
    if (entry?.type === 'menu' && isTempImage(entry.image)) cloneCollect.push({ obj: entry, key: 'image' });
    if (entry?.type === 'story' && isTempImage(entry.itemImage)) cloneCollect.push({ obj: entry, key: 'itemImage' });
  });

  const prefix = getProjectFilePrefix(project, projectPath) || sanitizeProjectPrefix(projectBaseName);
  for (const { obj, key } of cloneCollect) {
    const src = obj[key];
    const filename = src.replace(/.*[\\/]/, '');
    const prefixedName = prefix ? `${prefix}__${filename}` : filename;
    const dst = await uniquePathInDir(targetDir, prefixedName);
    await copyFile(src, dst);
    obj[key] = dst;
  }

  return projectToSerializable(updated);
}

export async function saveProject(project, existingPath = null, onProgress = null, options = {}) {
  let path = existingPath;

  if (!path) {
    const ws = options.workspaceDir || localStorage.getItem(WORKSPACE_DIR_KEY) || null;
    const lastDir = getStoredDir(PROJECT_SAVE_KEYS) ?? getStoredDir(PROJECT_OPEN_KEYS);
    const workspaceAutosaveDir = ws ? `${ws}/${AUTOSAVE_DIR_NAME}` : null;
    const defaultDir = workspaceAutosaveDir ?? lastDir;
    const suggestedName = (project.projectName || 'mon-projet').trim().replace(/[<>:"/\\|?*\[\]+]/g, '_');
    const chosenPath = await save({
      filters: [{ name: 'Projet LuniiPack', extensions: ['mbah'] }],
      defaultPath: defaultDir ? `${defaultDir}/${suggestedName}.mbah` : `${suggestedName}.mbah`,
      title: 'Enregistrer le projet...',
    });
    if (!chosenPath) return null;
    path = /\.mbah$/i.test(chosenPath) ? chosenPath : `${chosenPath}.mbah`;
  }

  if (options.autosave && !isProjectWorthAutosaving(project, options.mediaLibraryPaths ?? [], options.totalMediaCount ?? 0)) {
    throw new Error('Autosave annulée : le projet courant semble vide.');
  }

  onProgress?.('Enregistrement du projet...');
  const mbahDir = getProjectDir(path);
  const resolvedWs = options.workspaceDir || localStorage.getItem(WORKSPACE_DIR_KEY) || null;
  const projectForPath = options.autosave
    ? project
    : withLocalProjectNameForPath(project, path);
  // During autosave never move temp images — they'd land next to the autosave file, not the real project.
  // persistTempImages only runs on explicit saves so assets end up beside the user's chosen .mbah.
  const projectWithImages = options.autosave
    ? projectToSerializable(normalizeProjectData(projectForPath))
    : await persistTempImages(projectForPath, path, resolvedWs);
  const projectToSave = {
    ...mapProjectPaths(projectWithImages, (p) => toProjectRelative(p, mbahDir)),
    mediaTags: relativizeTagKeys(options.mediaTags ?? {}, mbahDir),
    mediaLibraryPaths: (options.mediaLibraryPaths ?? []).map((p) => toProjectRelative(p, mbahDir)),
  };
  const workspaceBackupDir = resolvedWs
    ? `${resolvedWs}/${AUTOSAVE_DIR_NAME}/${AUTOSAVE_BACKUP_DIR_NAME}`
    : null;
  await writeProjectFileAtomic(path, JSON.stringify(projectToSave, null, 2), {
    backupLimit: options.backupLimit ?? 0,
    backupDirOverride: options.backupDirOverride ?? workspaceBackupDir,
  });
  saveProjectDir(PROJECT_SAVE_KEYS[0], path);
  onProgress?.('Projet enregistré');
  // Return the project with absolute paths for in-memory use
  return { path, project: projectWithImages };
}

export async function saveProjectAs(project, currentSavePath, onProgress = null, mediaTags = {}, options = {}, mediaLibraryPaths = []) {
  const safeCurrentName = (project.projectName || 'mon-projet').trim().replace(/[<>:"/\\|?*\[\]+]/g, '_');
  const ws = options.workspaceDir || localStorage.getItem(WORKSPACE_DIR_KEY) || null;
  const workspaceAutosaveDir = ws ? `${ws}/${AUTOSAVE_DIR_NAME}` : null;
  const defaultDir = currentSavePath
    ? getProjectDir(currentSavePath)
    : (workspaceAutosaveDir ?? getStoredDir(PROJECT_SAVE_KEYS) ?? getStoredDir(PROJECT_OPEN_KEYS));
  const chosenPath = await save({
    filters: [{ name: 'Projet LuniiPack', extensions: ['mbah'] }],
    defaultPath: defaultDir ? `${defaultDir}/${safeCurrentName}.mbah` : `${safeCurrentName}.mbah`,
    title: 'Enregistrer une copie sous...',
  });
  if (!chosenPath) return null;

  const newPath = /\.mbah$/i.test(chosenPath) ? chosenPath : `${chosenPath}.mbah`;
  const newProjectDir = getProjectDir(newPath);

  onProgress?.('Enregistrement du projet...');

  const resolvedWs = options?.workspaceDir || localStorage.getItem(WORKSPACE_DIR_KEY) || null;
  onProgress?.('Décollage vers la lune...');
  const projectForPath = withLocalProjectNameForPath(project, newPath, { force: true });
  const projectWithImages = await persistTempImages(projectForPath, newPath, resolvedWs);
  const projectToSave = {
    ...mapProjectPaths(projectWithImages, (p) => toProjectRelative(p, newProjectDir)),
    mediaTags: relativizeTagKeys(mediaTags, newProjectDir),
    mediaLibraryPaths: mediaLibraryPaths.map((p) => toProjectRelative(p, newProjectDir)),
  };
  await writeProjectFileAtomic(newPath, JSON.stringify(projectToSave, null, 2));
  saveProjectDir(PROJECT_SAVE_KEYS[0], newPath);

  onProgress?.('Projet enregistré');
  return { path: newPath, project: projectWithImages };
}

export async function loadProject() {
  const path = await open({
    multiple: false,
    filters: [{ name: 'Projet LuniiPack', extensions: ['mbah'] }],
    defaultPath: getStoredDir(PROJECT_OPEN_KEYS) ?? getStoredDir(PROJECT_SAVE_KEYS),
  });
  if (!path) return null;
  saveProjectDir(PROJECT_OPEN_KEYS[0], path);
  return loadProjectFromPath(path);
}

function isProjectWorthAutosaving(project, mediaLibraryPaths = [], totalMediaCount = 0) {
  if (!project) return false;
  // Check media presence before projectType so imported folders/AI media trigger autosave
  if (mediaLibraryPaths.length > 0) return true;
  if (totalMediaCount > 0) return true;
  if (project.projectType == null) return false;
  if (hasPath(project.rootAudio) || hasPath(project.rootImage) || hasPath(project.thumbnailImage) || hasPath(project.nightModeAudio)) return true;
  let count = 0;
  visitProjectEntries(project, () => { count += 1; });
  return count > 0;
}

export async function loadProjectFromPath(path) {
  const text = await readTextFile(path);
  const mbahDir = getProjectDir(path);
  const rawData = JSON.parse(text);
  const mediaTags = absolutizeTagKeys(rawData.mediaTags, mbahDir);
  const mediaLibraryPaths = Array.isArray(rawData.mediaLibraryPaths)
    ? rawData.mediaLibraryPaths.map((p) => fromProjectRelative(p, mbahDir))
    : [];
  const withAbsolutePaths = mapProjectPaths(rawData, (p) => fromProjectRelative(p, mbahDir));
  const migrated = migrateProjectData(withAbsolutePaths, { savePath: path });
  return { data: normalizeProjectData(migrated), path, mediaTags, mediaLibraryPaths };
}

export function getExtractedZipsDir(workspaceDir) {
  if (!workspaceDir) return null;
  return workspaceDir.replace(/[\\/]+$/, '') + '/zips-extraits';
}

export async function ensureExportsDir(workspaceDir) {
  const baseDir = workspaceDir?.trim();
  if (!baseDir) return null;
  const path = baseDir.replace(/[\\/]+$/, '') + '/exports';
  try {
    await mkdir(path, { recursive: true });
    return path;
  } catch {
    return null;
  }
}

function mediaKindForPath(path) {
  const ext = String(path || '').toLowerCase().replace(/^.*\./, '');
  if (['mp3', 'ogg', 'wav', 'm4a', 'webm'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return 'images';
  if (['zip', '7z'].includes(ext)) return 'archives';
  return 'assets';
}

export async function consolidateProject(project, savePath, destinationDir, onProgress = null) {
  if (!destinationDir) return null;
  const normalized = normalizeProjectData(project);
  const serializable = JSON.parse(JSON.stringify(projectToSerializable(normalized)));
  const refs = [];
  const addRef = (obj, key) => {
    const value = obj?.[key];
    if (hasPath(value)) refs.push({ obj, key, path: value });
  };
  const addGraphRefs = (graph) => {
    for (const stage of graph?.document?.stageNodes ?? []) {
      addRef(stage, 'audio');
      addRef(stage, 'image');
    }
  };

  addRef(serializable, 'rootAudio');
  addRef(serializable, 'rootImage');
  addRef(serializable, 'thumbnailImage');
  addRef(serializable, 'nightModeAudio');
  addGraphRefs(serializable.nativeGraph);
  visitProjectEntries(serializable, (entry) => {
    addRef(entry, 'audio');
    addRef(entry, 'image');
    addRef(entry, 'itemAudio');
    addRef(entry, 'itemImage');
    addRef(entry, 'zipPath');
    addRef(entry, 'afterPlaybackPromptAudio');
    addGraphRefs(entry.nativeGraph);
    for (const step of entry.afterPlaybackSequence ?? []) {
      addRef(step, 'audio');
      addRef(step, 'image');
    }
    addRef(entry.afterPlaybackHomeStep, 'audio');
    addRef(entry.afterPlaybackHomeStep, 'image');
  });

  await mkdir(destinationDir, { recursive: true });
  const assetsRoot = `${destinationDir}/assets`;
  await mkdir(assetsRoot, { recursive: true });
  const copied = new Map();
  let copiedCount = 0;
  const errors = [];

  for (const ref of refs) {
    const key = normalizePath(ref.path);
    let nextPath = copied.get(key);
    if (!nextPath) {
      try {
        const kind = mediaKindForPath(ref.path);
        const targetDir = `${assetsRoot}/${kind}`;
        await mkdir(targetDir, { recursive: true });
        nextPath = await uniquePathInDir(targetDir, getFileName(ref.path));
        await copyFile(ref.path, nextPath);
        copied.set(key, nextPath);
        copiedCount += 1;
        onProgress?.(`Copie média ${copiedCount}/${refs.length}`);
      } catch (error) {
        errors.push({ path: ref.path, error: String(error) });
        continue;
      }
    }
    ref.obj[ref.key] = nextPath;
  }

  const fallbackName = savePath ? getFileName(savePath).replace(/\.mbah$/i, '') : 'projet';
  const projectName = (serializable.projectName || fallbackName || 'projet').trim().replace(/[<>:"/\\|?*\[\]+]/g, '_') || 'projet';
  const projectPath = `${destinationDir}/${projectName.replace(/\.mbah$/i, '')}-consolidee.mbah`;
  const projectToSave = mapProjectPaths(serializable, (p) => toProjectRelative(p, destinationDir));
  await writeProjectFileAtomic(projectPath, JSON.stringify(projectToSave, null, 2));
  return { path: projectPath, project: serializable, copiedCount, errors };
}

export function isAlreadyManagedFile(path, workspaceDir, savePath) {
  if (!hasPath(path)) return false;
  const ws = workspaceDir || localStorage.getItem(WORKSPACE_DIR_KEY) || '';
  if (ws && isManagedWorkspacePath(path, ws)) return true;
  if (hasPath(savePath)) return isManagedProjectPath(path, savePath);
  return false;
}

export async function autoSaveNewProject(project, workspaceDir, options = {}) {
  if (!workspaceDir) return null;
  const autosaveDir = `${workspaceDir}/${AUTOSAVE_DIR_NAME}`;
  await mkdir(autosaveDir, { recursive: true });

  const safeName = (project.projectName || 'nouveau-projet').trim()
    .replace(/[<>:"/\\|?*\[\]+]/g, '_')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'nouveau-projet';
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, 'h').replace(/-(\d{2})$/, 'm$1');
  const filename = `${safeName}_${stamp}.mbah`;
  const path = `${autosaveDir}/${filename}`;
  const backupDirOverride = `${autosaveDir}/${AUTOSAVE_BACKUP_DIR_NAME}`;

  return saveProject(project, path, null, {
    autosave: true,
    backupLimit: options.backupLimit ?? 0,
    backupDirOverride,
    mediaTags: options.mediaTags ?? {},
    mediaLibraryPaths: options.mediaLibraryPaths ?? [],
    totalMediaCount: options.totalMediaCount ?? 0,
  });
}

export async function copyMediaToWorkspace(sourcePath, workspaceDir, category = 'fichiers-importes', projectName = '') {
  if (!hasPath(sourcePath)) return sourcePath;
  const baseDir = workspaceDir || await getWorkspaceDir();
  const safeCategory = MANAGED_PROJECT_DIRS.includes(category) ? category : 'fichiers-importes';
  const targetDir = `${baseDir}/${safeCategory}`;
  await mkdir(targetDir, { recursive: true });
  if (isManagedWorkspacePath(sourcePath, baseDir)) return sourcePath;
  const prefix = sanitizeProjectPrefix(projectName);
  const originalName = getFileName(sourcePath);
  const targetName = prefix ? `${prefix}__${originalName}` : originalName;
  const dest = await uniquePathInDir(targetDir, targetName);
  await copyFile(sourcePath, dest);
  return dest;
}
