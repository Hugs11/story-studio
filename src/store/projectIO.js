import { open, save } from '@tauri-apps/plugin-dialog';
import { documentDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, copyFile, mkdir, rename, remove, exists, readDir } from '@tauri-apps/plugin-fs';
import { getProjectFilePrefix, sanitizeProjectPrefix } from '../utils/projectPrefix';
import { basename, basenameNoExt, dirname, joinPath, pathKey } from '../utils/fileUtils';
import { TEMP_IMAGES_DIR, LEGACY_TEMP_IMAGES_DIR } from '../utils/tempDirs';
import {
  migrateProjectData,
  normalizeProjectData,
  projectToRustExport,
  projectToSerializable,
  visitProjectEntries,
  walkProjectMediaReferences,
} from './projectModel';
import { selectStaleAutosaveBackups } from './autosaveDecision';
import { KEYS, read as readSetting, write as writeSetting } from './persistentSettings';
import {
  EXPORTS,
  FICHIERS_IMPORTES,
  IMAGES_GENEREES,
  MANAGED_PROJECT_DIRS,
  SAUVEGARDES,
  VERSIONS_SECURITE,
  ZIPS_EXTRAITS,
} from './workspaceDirs';
import { chooseCompatibleProjectPath, workspaceFallbackForProjectRelativePath } from './projectPathCompatibility';

const PROJECT_OPEN_KEYS = [KEYS.LAST_OPEN_PROJECT_DIR, KEYS.LAST_PROJECT_DIR];
const PROJECT_SAVE_KEYS = [KEYS.LAST_SAVE_PROJECT_DIR, KEYS.LAST_PROJECT_DIR];
const RECENT_PROJECT_LIMIT = 8;
const BACKUP_DIR_NAME = '.story-studio-backups';
// Caracteres interdits dans un nom de fichier `.mbah` propose a l'utilisateur.
const FILENAME_FORBIDDEN_CHARS = /[<>:"/\\|?*\[\]+]/g;

function sanitizeProjectFilename(name, fallback = 'mon-projet') {
  return String(name || fallback).trim().replace(FILENAME_FORBIDDEN_CHARS, '_');
}

function getStoredDir(keys) {
  for (const key of keys) {
    const value = readSetting(key);
    if (value) return value;
  }
  return undefined;
}

function saveProjectDir(key, filePath) {
  if (!filePath) return;
  const dir = filePath.replace(/[\\/][^\\/]+$/, '');
  if (dir) writeSetting(key, dir);
}

async function getDefaultWorkspaceDir() {
  const docs = await documentDir();
  return join(docs, 'story-studio');
}

export async function getWorkspaceDir() {
  const saved = readSetting(KEYS.WORKSPACE_DIR);
  if (saved?.trim()) return saved;
  const fallback = await getDefaultWorkspaceDir();
  writeSetting(KEYS.WORKSPACE_DIR, fallback);
  return fallback;
}

function setWorkspaceDir(path) {
  if (path?.trim()) writeSetting(KEYS.WORKSPACE_DIR, path);
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

function projectNameFromPath(path) {
  return basenameNoExt(path).trim();
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
    const raw = readSetting(KEYS.RECENT_PROJECTS);
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
    projectName: project?.projectName?.trim() || basenameNoExt(path) || 'Projet sans nom',
    name: project?.projectName?.trim() || basenameNoExt(path) || 'Projet sans nom',
    projectType: project?.projectType || 'pack',
    thumbnailImage: project?.thumbnailImage || project?.rootImage || null,
    updatedAt: Date.now(),
  };
  const next = [
    nextEntry,
    ...existing.filter((entry) => entry.path.replace(/\\/g, '/').toLowerCase() !== normalizedPath),
  ].slice(0, RECENT_PROJECT_LIMIT);
  writeSetting(KEYS.RECENT_PROJECTS, JSON.stringify(next));
  return next;
}

export function forgetRecentProject(path) {
  if (!path) return getRecentProjects();
  const normalizedPath = path.replace(/\\/g, '/').toLowerCase();
  const next = getRecentProjects()
    .filter((entry) => entry.path.replace(/\\/g, '/').toLowerCase() !== normalizedPath);
  writeSetting(KEYS.RECENT_PROJECTS, JSON.stringify(next));
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
  return pathKey(path)
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function getProjectDir(savePath) {
  return dirname(savePath);
}

function getFileName(path) {
  return basename(path);
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
  const projectBaseName = basenameNoExt(savePath);
  return joinPath(projectDir, `${projectBaseName}_assets`);
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

async function resolveLoadedProjectPath(maybeRelativePath, mbahDir, workspaceDir, cache) {
  if (!hasPath(maybeRelativePath)) return maybeRelativePath;
  if (!maybeRelativePath.startsWith('./') && !maybeRelativePath.startsWith('../')) return maybeRelativePath;

  const cacheKey = `${mbahDir}\n${workspaceDir}\n${maybeRelativePath}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const projectPath = fromProjectRelative(maybeRelativePath, mbahDir);
  const workspacePath = workspaceFallbackForProjectRelativePath(maybeRelativePath, workspaceDir);
  if (!workspacePath || normalizePath(projectPath) === normalizePath(workspacePath)) {
    cache.set(cacheKey, projectPath);
    return projectPath;
  }

  const [projectExists, workspaceExists] = await Promise.all([
    exists(projectPath).catch(() => false),
    exists(workspacePath).catch(() => false),
  ]);
  const resolvedPath = chooseCompatibleProjectPath(maybeRelativePath, projectPath, workspaceDir, {
    projectExists,
    workspaceExists,
  });
  cache.set(cacheKey, resolvedPath);
  return resolvedPath;
}

async function resolveLoadedProjectPaths(project, mbahDir, workspaceDir, cache) {
  const cloned = structuredClone(project);
  for (const ref of walkProjectMediaReferences(cloned)) {
    ref.obj[ref.key] = await resolveLoadedProjectPath(ref.path, mbahDir, workspaceDir, cache);
  }
  return cloned;
}

async function absolutizeTagKeysWithCompatibility(tags, mbahDir, workspaceDir, cache) {
  if (!tags || typeof tags !== 'object') return {};
  const result = {};
  for (const [path, tagList] of Object.entries(tags)) {
    if (!Array.isArray(tagList) || tagList.length === 0) continue;
    const resolvedPath = await resolveLoadedProjectPath(path, mbahDir, workspaceDir, cache);
    result[resolvedPath] = tagList;
  }
  return result;
}

// Applique transformFn a chaque path media du projet, retourne un clone modifie.
function mapProjectPaths(project, transformFn) {
  const cloned = structuredClone(project);
  for (const ref of walkProjectMediaReferences(cloned)) {
    ref.obj[ref.key] = transformFn(ref.path);
  }
  return cloned;
}

function isManagedProjectPath(path, savePath) {
  if (!hasPath(path) || !hasPath(savePath)) return false;
  const workspaceDir = readSetting(KEYS.WORKSPACE_DIR);
  if (isManagedWorkspacePath(path, workspaceDir)) return true;
  const projectDir = getProjectDir(savePath);
  if (isPathInsideDir(path, projectDir)) return true;
  if (isPathInsideDir(path, getProjectAssetsDir(savePath))) return true;
  return MANAGED_PROJECT_DIRS.some((dirName) => isPathInsideDir(path, joinPath(projectDir, dirName)));
}

function isManagedWorkspacePath(path, workspaceDir) {
  if (!hasPath(path) || !hasPath(workspaceDir)) return false;
  return MANAGED_PROJECT_DIRS.some((dirName) => isPathInsideDir(path, joinPath(workspaceDir, dirName)));
}

function shouldTransferProjectPath(path, savePath, statusByPath = null) {
  if (!hasPath(path) || !hasPath(savePath)) return false;
  if (statusByPath?.[path] === false) return false;
  if (isTempImage(path)) return false;
  return !isManagedProjectPath(path, savePath);
}

// Construit la liste mutable des references a transferer, sur un clone du projet.
// Le caller peut muter `ref.obj[ref.key]` pour rediriger les chemins.
function collectTransferTargets(project, savePath, statusByPath = null) {
  const updated = structuredClone(projectToSerializable(normalizeProjectData(project)));
  const refs = [];
  for (const ref of walkProjectMediaReferences(updated)) {
    if (!shouldTransferProjectPath(ref.path, savePath, statusByPath)) continue;
    refs.push(ref);
  }
  return { updated, refs };
}

// Vue lecture-seule pour l'UI : candidates uniques (path/label/filename)
// que l'utilisateur peut accepter ou refuser de copier dans le projet.
export function collectTransferableProjectFiles(project, savePath, statusByPath = null) {
  if (!hasPath(savePath)) return [];
  const normalized = normalizeProjectData(project);
  const seen = new Set();
  const candidates = [];
  for (const ref of walkProjectMediaReferences(normalized)) {
    if (!shouldTransferProjectPath(ref.path, savePath, statusByPath)) continue;
    const key = normalizePath(ref.path);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      path: ref.path,
      label: ref.label,
      filename: basename(ref.path) || ref.path,
    });
  }
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
  let candidate = joinPath(dir, fileName);
  if (!(await exists(candidate))) return candidate;
  const { stem, ext } = splitFileName(fileName);
  for (let index = 1; index < 1000; index += 1) {
    candidate = joinPath(dir, `${stem}--${Date.now()}-${index}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Impossible de créer un nom unique pour ${fileName}`);
}

async function backupProjectFile(path, limit = 0, backupDirOverride = null) {
  const keep = Number(limit) || 0;
  if (keep <= 0 || !path || !(await exists(path))) return;
  const projectDir = getProjectDir(path);
  const baseName = basenameNoExt(path);
  const backupDir = backupDirOverride ?? joinPath(projectDir, BACKUP_DIR_NAME);
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(path, joinPath(backupDir, `${baseName}.${stamp}.mbah`));

  const entries = await readDir(backupDir).catch(() => []);
  for (const stale of selectStaleAutosaveBackups(entries, baseName, keep)) {
    await remove(joinPath(backupDir, stale)).catch(() => {});
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
 * Retourne un projet serialisable avec les chemins mis à jour.
 */
async function persistTempImages(project, projectPath, workspaceDir = null) {
  const updated = structuredClone(projectToSerializable(normalizeProjectData(project)));

  // Une seule traversee : on collecte uniquement les images temporaires editables.
  // `walkProjectMediaReferences` couvre rootImage/thumbnailImage + menu.image + story.itemImage,
  // mais on filtre `scope: 'native-graph'` pour ne pas toucher aux assets graphe natif preserves.
  const tempRefs = [];
  for (const ref of walkProjectMediaReferences(updated)) {
    if (ref.scope === 'native-graph') continue;
    if (ref.key !== 'rootImage' && ref.key !== 'thumbnailImage' && ref.key !== 'image' && ref.key !== 'itemImage') continue;
    if (!isTempImage(ref.path)) continue;
    tempRefs.push(ref);
  }

  if (tempRefs.length === 0) return updated;

  const resolvedWs = workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
  const baseDir = resolvedWs || getProjectDir(projectPath);
  const targetDir = joinPath(baseDir, IMAGES_GENEREES);
  await mkdir(targetDir, { recursive: true });

  const prefix = getProjectFilePrefix(project, projectPath) || sanitizeProjectPrefix(basenameNoExt(projectPath));
  for (const ref of tempRefs) {
    const src = ref.path;
    const filename = basename(src);
    const prefixedName = prefix ? `${prefix}__${filename}` : filename;
    const dst = await uniquePathInDir(targetDir, prefixedName);
    await copyFile(src, dst);
    ref.obj[ref.key] = dst;
  }

  return updated;
}

export async function saveProject(project, existingPath = null, onProgress = null, options = {}) {
  let path = existingPath;

  if (!path) {
    const ws = options.workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
    const lastDir = getStoredDir(PROJECT_SAVE_KEYS) ?? getStoredDir(PROJECT_OPEN_KEYS);
    const workspaceAutosaveDir = ws ? joinPath(ws, SAUVEGARDES) : null;
    const defaultDir = workspaceAutosaveDir ?? lastDir;
    const suggestedName = sanitizeProjectFilename(project.projectName);
    const chosenPath = await save({
      filters: [{ name: 'Projet LuniiPack', extensions: ['mbah'] }],
      defaultPath: defaultDir ? joinPath(defaultDir, `${suggestedName}.mbah`) : `${suggestedName}.mbah`,
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
  const resolvedWs = options.workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
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
    // Tags are still keyed by media path. Keys are relativized in .mbah files
    // to survive project-folder moves; content-hash tags would be a future
    // migration if we need to track renamed files inside the workspace.
    mediaTags: relativizeTagKeys(options.mediaTags ?? {}, mbahDir),
    mediaLibraryPaths: (options.mediaLibraryPaths ?? []).map((p) => toProjectRelative(p, mbahDir)),
  };
  const workspaceBackupDir = resolvedWs
    ? joinPath(resolvedWs, SAUVEGARDES, VERSIONS_SECURITE)
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
  const safeCurrentName = sanitizeProjectFilename(project.projectName);
  const ws = options.workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
  const workspaceAutosaveDir = ws ? joinPath(ws, SAUVEGARDES) : null;
  const defaultDir = currentSavePath
    ? getProjectDir(currentSavePath)
    : (workspaceAutosaveDir ?? getStoredDir(PROJECT_SAVE_KEYS) ?? getStoredDir(PROJECT_OPEN_KEYS));
  const chosenPath = await save({
    filters: [{ name: 'Projet LuniiPack', extensions: ['mbah'] }],
    defaultPath: defaultDir ? joinPath(defaultDir, `${safeCurrentName}.mbah`) : `${safeCurrentName}.mbah`,
    title: 'Enregistrer une copie sous...',
  });
  if (!chosenPath) return null;

  const newPath = /\.mbah$/i.test(chosenPath) ? chosenPath : `${chosenPath}.mbah`;
  const newProjectDir = getProjectDir(newPath);

  onProgress?.('Enregistrement du projet...');

  const resolvedWs = options?.workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
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
  const workspaceDir = await getWorkspaceDir();
  const compatibilityCache = new Map();
  const mediaTags = await absolutizeTagKeysWithCompatibility(rawData.mediaTags, mbahDir, workspaceDir, compatibilityCache);
  const mediaLibraryPaths = Array.isArray(rawData.mediaLibraryPaths)
    ? await Promise.all(rawData.mediaLibraryPaths.map((p) => resolveLoadedProjectPath(p, mbahDir, workspaceDir, compatibilityCache)))
    : [];
  const withAbsolutePaths = await resolveLoadedProjectPaths(rawData, mbahDir, workspaceDir, compatibilityCache);
  const migrated = migrateProjectData(withAbsolutePaths, { savePath: path });
  return { data: normalizeProjectData(migrated), path, mediaTags, mediaLibraryPaths };
}

export function getExtractedZipsDir(workspaceDir) {
  if (!workspaceDir) return null;
  return joinPath(workspaceDir, ZIPS_EXTRAITS);
}

export async function ensureExportsDir(workspaceDir) {
  const baseDir = workspaceDir?.trim();
  if (!baseDir) return null;
  const path = joinPath(baseDir, EXPORTS);
  try {
    await mkdir(path, { recursive: true });
    return path;
  } catch {
    return null;
  }
}

function mediaKindForPath(path) {
  const ext = String(path || '').toLowerCase().replace(/^.*\./, '');
  if (['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac'].includes(ext)) return 'audio';
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return 'images';
  if (['zip', '7z'].includes(ext)) return 'archives';
  return 'assets';
}

export async function consolidateProject(project, savePath, destinationDir, onProgress = null) {
  if (!destinationDir) return null;
  const normalized = normalizeProjectData(project);
  const serializable = structuredClone(projectToSerializable(normalized));
  const refs = [...walkProjectMediaReferences(serializable)];

  await mkdir(destinationDir, { recursive: true });
  const assetsRoot = joinPath(destinationDir, 'assets');
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
        const targetDir = joinPath(assetsRoot, kind);
        await mkdir(targetDir, { recursive: true });
        nextPath = await uniquePathInDir(targetDir, basename(ref.path));
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

  const fallbackName = savePath ? basenameNoExt(savePath) : 'projet';
  const projectName = sanitizeProjectFilename(serializable.projectName || fallbackName, 'projet') || 'projet';
  const projectPath = joinPath(destinationDir, `${projectName.replace(/\.mbah$/i, '')}-consolidee.mbah`);
  const projectToSave = mapProjectPaths(serializable, (p) => toProjectRelative(p, destinationDir));
  await writeProjectFileAtomic(projectPath, JSON.stringify(projectToSave, null, 2));
  return { path: projectPath, project: serializable, copiedCount, errors };
}

export function isAlreadyManagedFile(path, workspaceDir, savePath) {
  if (!hasPath(path)) return false;
  const ws = workspaceDir || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' });
  if (ws && isManagedWorkspacePath(path, ws)) return true;
  if (hasPath(savePath)) return isManagedProjectPath(path, savePath);
  return false;
}

export async function autoSaveNewProject(project, workspaceDir, options = {}) {
  if (!workspaceDir) return null;
  const autosaveDir = joinPath(workspaceDir, SAUVEGARDES);
  await mkdir(autosaveDir, { recursive: true });

  const safeName = sanitizeProjectFilename(project.projectName, 'nouveau-projet')
    .replace(/\s+/g, '-')
    .toLowerCase() || 'nouveau-projet';
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, 'h').replace(/-(\d{2})$/, 'm$1');
  const filename = `${safeName}_${stamp}.mbah`;
  const path = joinPath(autosaveDir, filename);
  const backupDirOverride = joinPath(autosaveDir, VERSIONS_SECURITE);

  return saveProject(project, path, null, {
    autosave: true,
    backupLimit: options.backupLimit ?? 0,
    backupDirOverride,
    mediaTags: options.mediaTags ?? {},
    mediaLibraryPaths: options.mediaLibraryPaths ?? [],
    totalMediaCount: options.totalMediaCount ?? 0,
  });
}

export async function copyMediaToWorkspace(sourcePath, workspaceDir, category = FICHIERS_IMPORTES, projectName = '') {
  if (!hasPath(sourcePath)) return sourcePath;
  const baseDir = workspaceDir || await getWorkspaceDir();
  const safeCategory = MANAGED_PROJECT_DIRS.includes(category) ? category : FICHIERS_IMPORTES;
  const targetDir = joinPath(baseDir, safeCategory);
  await mkdir(targetDir, { recursive: true });
  if (isManagedWorkspacePath(sourcePath, baseDir)) return sourcePath;
  const prefix = sanitizeProjectPrefix(projectName);
  const originalName = basename(sourcePath);
  const targetName = prefix ? `${prefix}__${originalName}` : originalName;
  const dest = await uniquePathInDir(targetDir, targetName);
  await copyFile(sourcePath, dest);
  return dest;
}
