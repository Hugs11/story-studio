import { open, save } from '@tauri-apps/plugin-dialog';
import { documentDir, join } from '@tauri-apps/api/path';
import { readTextFile, writeTextFile, copyFile, mkdir, rename, remove, exists, readDir } from '@tauri-apps/plugin-fs';
import { getProjectFilePrefix, sanitizeProjectPrefix } from '../utils/projectPrefix';
import { isFallbackProjectName, suggestProjectName } from './projectSaveName.js';
import { createAdvancedViewBridge } from './advancedGraphView/advancedViewBridge.js';
import {
  basename,
  basenameNoExt,
  dirname,
  isPathInside,
  joinPath,
  pathKey,
} from '../utils/fileUtils';
import { TEMP_IMAGES_DIR, LEGACY_TEMP_IMAGES_DIR } from '../utils/tempDirs';
import {
  decodeProjectFile,
  encodeProjectFile,
  projectFileBody,
  projectPreviewThumbnail,
  projectToRustExport,
  readMediaBindings,
  readProjectFilePreview,
  resolveMediaBindingStatuses,
  walkProjectMediaReferences,
} from './projectModel';
import {
  fromProjectRelativeMediaPath,
  relativizeProjectMediaPaths,
  toProjectRelativeMediaPath,
} from './projectMediaPaths';
import { isProjectWorthAutosaving, selectStaleAutosaveBackups } from './autosaveDecision';
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
import { reconcileMediaLibraryPaths } from './mediaLibrary';
import { collectSessionBoundReferences } from './sessionMediaTriage';
import {
  imageEditMetadataPath,
  readImageEditMetadata,
  supportsImageEditMetadata,
  withImageEditSourcePath,
  writeImageEditMetadata,
} from './imageEditMetadata';

const PROJECT_OPEN_KEYS = [KEYS.LAST_OPEN_PROJECT_DIR, KEYS.LAST_PROJECT_DIR];
const PROJECT_SAVE_KEYS = [KEYS.LAST_SAVE_PROJECT_DIR, KEYS.LAST_PROJECT_DIR];
const RECENT_PROJECT_LIMIT = 8;
const BACKUP_DIR_NAME = '.story-studio-backups';
// Caracteres interdits dans un nom de fichier `.mbah` propose a l'utilisateur.
const FILENAME_FORBIDDEN_CHARS = /[<>:"/\\|?*\[\]+]/g;

function sanitizeProjectFilename(name, fallback = 'mon-projet') {
  return String(name || fallback).trim().replace(FILENAME_FORBIDDEN_CHARS, '_');
}

async function projectSaveFilename(project, currentSavePath = null) {
  let documentTitle = null;
  if (project?.authoringMode === 'advanced') {
    try {
      // Lire ce payload précis évite de nommer le fichier depuis une vue UI
      // encore associée au document précédent ou au titre avant renommage.
      const view = await createAdvancedViewBridge().readGraphView(project.authoring.payload);
      if (view?.metadata?.title?.presence === 'value') documentTitle = view.metadata.title.value;
    } catch {
      // Une lecture indisponible ne doit pas empêcher de conserver le travail.
      // Le nom local (ou celui du fichier existant) reste utilisable en repli.
    }
  }
  return sanitizeProjectFilename(suggestProjectName(project, {
    documentTitle,
    currentFileName: currentSavePath ? basenameNoExt(currentSavePath) : '',
  }));
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
  return getDefaultWorkspaceDir();
}

function setWorkspaceDir(path) {
  if (path?.trim()) writeSetting(KEYS.WORKSPACE_DIR, path);
}

export async function ensureWorkspaceDir() {
  const dir = await getWorkspaceDir();
  setWorkspaceDir(dir);
  await mkdir(dir, { recursive: true });
  return dir;
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
  const normalizedPath = pathKey(path);
  const nextEntry = {
    path,
    projectName: project?.projectName?.trim() || basenameNoExt(path) || 'Projet sans nom',
    name: project?.projectName?.trim() || basenameNoExt(path) || 'Projet sans nom',
    projectType: project?.projectType || 'pack',
    thumbnailImage: projectPreviewThumbnail(project),
    updatedAt: Date.now(),
  };
  const next = [
    nextEntry,
    ...existing.filter((entry) => pathKey(entry.path) !== normalizedPath),
  ].slice(0, RECENT_PROJECT_LIMIT);
  writeSetting(KEYS.RECENT_PROJECTS, JSON.stringify(next));
  return next;
}

export function forgetRecentProject(path) {
  if (!path) return getRecentProjects();
  const normalizedPath = pathKey(path);
  const next = getRecentProjects()
    .filter((entry) => pathKey(entry.path) !== normalizedPath);
  writeSetting(KEYS.RECENT_PROJECTS, JSON.stringify(next));
  return next;
}

/** Détecte si un chemin est une image temporaire produite par Story Studio */
function isTempImage(path) {
  if (typeof path !== 'string') return false;
  const normalized = pathKey(path);
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

function relativizeTagKeys(tags, mbahDir) {
  if (!tags || typeof tags !== 'object') return {};
  const result = {};
  for (const [path, tagList] of Object.entries(tags)) {
    if (Array.isArray(tagList) && tagList.length > 0) {
      result[toProjectRelativeMediaPath(path, mbahDir)] = tagList;
    }
  }
  return result;
}

async function resolveLoadedProjectPath(maybeRelativePath, mbahDir, workspaceDir, cache) {
  if (!hasPath(maybeRelativePath)) return maybeRelativePath;
  if (!maybeRelativePath.startsWith('./') && !maybeRelativePath.startsWith('../')) return maybeRelativePath;

  const cacheKey = `${mbahDir}\n${workspaceDir}\n${maybeRelativePath}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const projectPath = fromProjectRelativeMediaPath(maybeRelativePath, mbahDir);
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

function isManagedProjectPath(path, savePath) {
  if (!hasPath(path) || !hasPath(savePath)) return false;
  const workspaceDir = readSetting(KEYS.WORKSPACE_DIR);
  if (isManagedWorkspacePath(path, workspaceDir)) return true;
  const projectDir = getProjectDir(savePath);
  if (isPathInside(path, projectDir)) return true;
  if (isPathInside(path, getProjectAssetsDir(savePath))) return true;
  return MANAGED_PROJECT_DIRS.some((dirName) => isPathInside(path, joinPath(projectDir, dirName)));
}

function isManagedWorkspacePath(path, workspaceDir) {
  if (!hasPath(path) || !hasPath(workspaceDir)) return false;
  return MANAGED_PROJECT_DIRS.some((dirName) => isPathInside(path, joinPath(workspaceDir, dirName)));
}

function shouldTransferProjectPath(path, savePath, statusByPath = null) {
  if (!hasPath(path) || !hasPath(savePath)) return false;
  if (statusByPath?.[path] === false) return false;
  if (isTempImage(path)) return false;
  return !isManagedProjectPath(path, savePath);
}

// Construit la liste mutable des references a transferer, sur un clone du projet.
// L'appelant peut muter `ref.obj[ref.key]` pour rediriger les chemins.
function collectTransferTargets(project, savePath, statusByPath = null) {
  const updated = projectFileBody(project);
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
  // Le mode Avancé passe par la même vue : une liaison média déclarée est une
  // candidate au même titre qu'une référence d'arbre, et `assetRef` n'est jamais
  // proposé au transfert — seul son `path` l'est.
  const seen = new Set();
  const candidates = [];
  for (const ref of walkProjectMediaReferences(projectFileBody(project))) {
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
    return { project: updated, copiedCount: 0, copies: [], errors: [] };
  }

  const copiedPaths = new Map();
  // Copies réalisées `{ from, to }` : permet aux consommateurs de re-pointer
  // bibliothèque et tags sans re-copier les fichiers.
  const copies = [];
  const errors = [];

  for (const ref of refs) {
    const cacheKey = normalizePath(ref.path);
    let nextPath = copiedPaths.get(cacheKey);

    if (!nextPath) {
      try {
        nextPath = await copyToProject(ref.path, savePath);
        copiedPaths.set(cacheKey, nextPath);
        copies.push({ from: ref.path, to: nextPath });
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
    // Une copie réussie est un fait de disque : la liaison qui la désigne passe
    // à `resolved`. Une copie échouée garde son dernier chemin connu et son
    // état ; le transfert ne retire ni ne réordonne jamais une liaison, et ne
    // requalifie rien quand il n'a rien copié.
    project: copies.length === 0
      ? updated
      : resolveMediaBindingStatuses(updated, Object.fromEntries(copies.map(({ to }) => [to, true]))),
    copiedCount: copiedPaths.size,
    copies,
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

// Le fichier précédent n'est remplacé que par un `rename` sur un temporaire
// complet : ni l'écriture ni le remplacement ne peuvent le laisser à moitié
// réécrit. Le backup est pris avant, donc il conserve l'état valide même quand
// l'écriture échoue ensuite ; le temporaire, lui, est retiré dans les deux cas.
async function writeProjectFileAtomic(path, contents, { backupLimit = 0, backupDirOverride = null } = {}) {
  await backupProjectFile(path, backupLimit, backupDirOverride);
  const tmpPath = `${path}.tmp-${Date.now()}`;
  try {
    await writeTextFile(tmpPath, contents);
    await rename(tmpPath, path);
  } catch (error) {
    await remove(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Copie les images temporaires vers {workspaceDir}/images-generees/.
 * Sans workspace fourni, l'emplacement de travail configuré (ou celui par
 * défaut) : jamais un dossier à côté du .mbah.
 * Retourne un projet serialisable avec les chemins mis à jour.
 * Chaque copie créée est consignée dans `createdCopies` (`{ from, to }`) au fil
 * de l'eau : un échec en cours de route laisse la liste exacte à retirer.
 */
async function persistTempImages(project, projectPath, workspaceDir = null, createdCopies = null) {
  const updated = projectFileBody(project);

  // Une seule traversee : on collecte uniquement les images temporaires editables.
  // `walkProjectMediaReferences` couvre rootImage/thumbnailImage + menu.image + story.itemImage,
  // mais on filtre `scope: 'native-graph'` pour ne pas toucher aux assets graphe natif preserves,
  // et `scope: 'advanced-asset'` pour la meme raison : une liaison d'auteur n'est
  // jamais une image temporaire a deplacer vers `images-generees/`.
  const tempRefs = [];
  for (const ref of walkProjectMediaReferences(updated)) {
    if (ref.scope === 'native-graph' || ref.scope === 'advanced-asset') continue;
    if (ref.key !== 'rootImage' && ref.key !== 'thumbnailImage' && ref.key !== 'image' && ref.key !== 'itemImage') continue;
    if (!isTempImage(ref.path)) continue;
    tempRefs.push(ref);
  }

  if (tempRefs.length === 0) return updated;

  const baseDir = workspaceDir || await getWorkspaceDir();
  const prefix = getProjectFilePrefix(project, projectPath) || sanitizeProjectPrefix(basenameNoExt(projectPath));
  for (const ref of tempRefs) {
    const copied = await copyMediaToWorkspace(
      ref.path,
      baseDir,
      IMAGES_GENEREES,
      prefix,
      { artifactCopies: createdCopies },
    );
    createdCopies?.push({ from: ref.path, to: copied });
    ref.obj[ref.key] = copied;
  }

  return updated;
}

/**
 * Retire les copies de médias qu'une opération a créées puis abandonnées :
 * aucun fichier écrit ne les désigne, elles ne seraient que des fichiers en
 * trop. Seule une vraie copie est retirée — une entrée dont la destination est
 * sa source désigne un fichier déjà présent, qui n'appartient pas à
 * l'opération. `keepPaths` protège les copies que l'état en mémoire a déjà
 * reprises. Un retrait impossible est ignoré : le reliquat reste inoffensif.
 */
export async function discardMediaCopies(copies = [], { keepPaths = [] } = {}) {
  const skipped = new Set(keepPaths.filter(hasPath).map(pathKey));
  for (const copy of copies) {
    if (!hasPath(copy?.to) || pathKey(copy.to) === pathKey(copy.from ?? '')) continue;
    const key = pathKey(copy.to);
    if (skipped.has(key)) continue;
    skipped.add(key);
    await cleanupIncompleteImageArtifact(copy.to);
  }
}

export async function saveProject(project, existingPath = null, onProgress = null, options = {}) {
  let path = existingPath;

  if (!path) {
    const ws = options.workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
    const lastDir = getStoredDir(PROJECT_SAVE_KEYS) ?? getStoredDir(PROJECT_OPEN_KEYS);
    const workspaceAutosaveDir = ws ? joinPath(ws, SAUVEGARDES) : null;
    const defaultDir = workspaceAutosaveDir ?? lastDir;
    const suggestedName = await projectSaveFilename(project);
    const chosenPath = await save({
      filters: [{ name: 'Projet LuniiPack', extensions: ['mbah'] }],
      defaultPath: defaultDir ? joinPath(defaultDir, `${suggestedName}.mbah`) : `${suggestedName}.mbah`,
      title: 'Enregistrer le projet...',
    });
    if (!chosenPath) return null;
    path = /\.mbah$/i.test(chosenPath) ? chosenPath : `${chosenPath}.mbah`;
  }

  if (options.autosave
    && !isProjectWorthAutosaving(project, options.mediaLibraryPaths ?? [], options.totalMediaCount ?? 0)
    && Object.keys(options.mediaTags ?? {}).length === 0) {
    throw new Error('Autosave annulée : le projet courant semble vide.');
  }

  onProgress?.('Enregistrement du projet...');
  const mbahDir = getProjectDir(path);
  const resolvedWs = options.workspaceDir || readSetting(KEYS.WORKSPACE_DIR) || null;
  const projectForPath = options.autosave
    ? project
    : withLocalProjectNameForPath(project, path);
  // Les images copiées ne valent que par le fichier qui les désigne : si
  // l'écriture échoue, elles sont retirées.
  const createdCopies = [];
  let projectWithImages;
  let reconciledMediaLibraryPaths;
  try {
    // Une sauvegarde automatique ne déplace jamais les images temporaires :
    // seule une sauvegarde explicite les copie dans l'emplacement de travail.
    projectWithImages = options.autosave
      ? projectFileBody(projectForPath)
      : await persistTempImages(projectForPath, path, resolvedWs, createdCopies);
    const catalogPathsForSave = options.autosave
      ? (options.mediaLibraryPaths ?? [])
      : (options.mediaLibraryPaths ?? []).filter((mediaPath) => !isTempImage(mediaPath));
    reconciledMediaLibraryPaths = reconcileMediaLibraryPaths(projectWithImages, catalogPathsForSave);
    const projectToSave = {
      ...relativizeProjectMediaPaths(projectWithImages, mbahDir),
      // Tags are still keyed by media path. Keys are relativized in .mbah files
      // to survive project-folder moves; content-hash tags would be a future
      // migration if we need to track renamed files inside the workspace.
      mediaTags: relativizeTagKeys(options.mediaTags ?? {}, mbahDir),
      mediaLibraryPaths: reconciledMediaLibraryPaths
        .map((p) => toProjectRelativeMediaPath(p, mbahDir)),
    };
    const workspaceBackupDir = resolvedWs
      ? joinPath(resolvedWs, SAUVEGARDES, VERSIONS_SECURITE)
      : null;
    await writeProjectFileAtomic(path, encodeProjectFile(projectToSave, { fileName: basename(path) }), {
      backupLimit: options.backupLimit ?? 0,
      backupDirOverride: options.backupDirOverride ?? workspaceBackupDir,
    });
  } catch (error) {
    await discardMediaCopies(createdCopies);
    throw error;
  }
  if (!options.autosave) {
    saveProjectDir(PROJECT_SAVE_KEYS[0], path);
  }
  onProgress?.('Projet enregistré');
  // Return the project with absolute paths for in-memory use
  return { path, project: projectWithImages, mediaLibraryPaths: reconciledMediaLibraryPaths };
}

/**
 * Écrit un projet dans un fichier **neuf**, sans jamais en écraser un : un
 * fichier déjà présent fait échouer l'écriture. Un échec en cours de route
 * retire le fichier que cette écriture a créé, et lui seul. Aucun média n'est
 * copié : les chemins sont seulement relativisés au dossier du fichier.
 */
export async function writeNewProjectFile(project, path) {
  if (await exists(path)) {
    throw new Error(`Un fichier porte déjà ce nom : ${basename(path)}.`);
  }
  const contents = encodeProjectFile(
    relativizeProjectMediaPaths(projectFileBody(project), getProjectDir(path)),
    { fileName: basename(path) },
  );
  try {
    await writeTextFile(path, contents, { createNew: true });
  } catch (error) {
    // Un fichier apparu entre la vérification et l'écriture n'est pas le nôtre :
    // on n'y touche pas. Toute autre panne laisse un fichier partiel, le nôtre.
    const alreadyThere = /exist/i.test(String(error?.message ?? error));
    if (!alreadyThere) await remove(path).catch(() => {});
    throw error;
  }
  return path;
}

export async function saveProjectAs(project, currentSavePath, onProgress = null, mediaTags = {}, options = {}, mediaLibraryPaths = []) {
  const safeCurrentName = await projectSaveFilename(project, currentSavePath);
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
  const catalogPathsForSave = mediaLibraryPaths.filter((mediaPath) => !isTempImage(mediaPath));
  // `deferWrite` : le chemin est choisi et le projet préparé, mais rien n'est
  // écrit. L'appelant écrit lui-même une fois ses médias à l'abri — un fichier
  // posé avant eux désignerait des médias qui peuvent disparaître, et un
  // fichier existant qu'on écrase ne doit pas être perdu si l'opération
  // échoue ensuite. Les images temporaires restent en place : l'écriture de
  // l'appelant les copie, et une opération abandonnée avant n'en laisse aucune
  // copie orpheline.
  if (options.deferWrite) {
    const projectBody = projectFileBody(projectForPath);
    return {
      path: newPath,
      project: projectBody,
      mediaLibraryPaths: reconcileMediaLibraryPaths(projectBody, catalogPathsForSave),
      written: false,
    };
  }
  const createdCopies = [];
  let projectWithImages;
  let reconciledMediaLibraryPaths;
  try {
    projectWithImages = await persistTempImages(projectForPath, newPath, resolvedWs, createdCopies);
    reconciledMediaLibraryPaths = reconcileMediaLibraryPaths(projectWithImages, catalogPathsForSave);
    const projectToSave = {
      ...relativizeProjectMediaPaths(projectWithImages, newProjectDir),
      mediaTags: relativizeTagKeys(mediaTags, newProjectDir),
      mediaLibraryPaths: reconciledMediaLibraryPaths
        .map((p) => toProjectRelativeMediaPath(p, newProjectDir)),
    };
    await writeProjectFileAtomic(newPath, encodeProjectFile(projectToSave, { fileName: basename(newPath) }));
  } catch (error) {
    await discardMediaCopies(createdCopies);
    throw error;
  }
  saveProjectDir(PROJECT_SAVE_KEYS[0], newPath);

  onProgress?.('Projet enregistré');
  return {
    path: newPath,
    project: projectWithImages,
    mediaLibraryPaths: reconciledMediaLibraryPaths,
    written: true,
  };
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

export async function loadProjectFromPath(path, { preserveEmptyProjectName = false } = {}) {
  const text = await readTextFile(path);
  const mbahDir = getProjectDir(path);
  const workspaceDir = await getWorkspaceDir();
  const compatibilityCache = new Map();
  // Le codec identifie l'enveloppe et valide le payload avant que le moindre
  // chemin ne soit résolu : un fichier refusé n'entre pas en mémoire, et rien
  // n'est réécrit sur le disque. La résolution disque, elle, reste ici.
  const { project, summary } = await decodeProjectFile(text, {
    fileName: basename(path) || path,
    savePath: path,
    preserveEmptyProjectName,
    resolveMediaPaths: (raw) => resolveLoadedProjectPaths(raw, mbahDir, workspaceDir, compatibilityCache),
  });
  // `mediaTags` et `mediaLibraryPaths` appartiennent au fichier, pas au projet
  // en mémoire : le catalogue et ses tags sont rendus à part, résolus avec le
  // repli workspace. Les laisser dans le projet dupliquerait un état que le
  // normaliseur Libre supprime déjà, aux deux modes cette fois.
  const { mediaTags: fileMediaTags, mediaLibraryPaths: fileMediaLibraryPaths, ...data } = project;
  const mediaTags = await absolutizeTagKeysWithCompatibility(fileMediaTags, mbahDir, workspaceDir, compatibilityCache);
  const mediaLibraryPaths = Array.isArray(fileMediaLibraryPaths)
    ? await Promise.all(fileMediaLibraryPaths.map((p) => resolveLoadedProjectPath(p, mbahDir, workspaceDir, compatibilityCache)))
    : [];
  return {
    data,
    path,
    summary,
    mediaTags,
    mediaLibraryPaths: reconcileMediaLibraryPaths(data, mediaLibraryPaths),
  };
}

// Aperçu d'un fichier projet pour une liste, sans l'ouvrir. Le codec ne lit que
// l'enveloppe : ni migration, ni normalisation, ni validation Rust du payload,
// et aucune écriture — énumérer des reprises de session ne peut donc pas générer
// une identité ni modifier un snapshot. Seul le chemin de la vignette est résolu,
// parce qu'il doit être affichable ; le reste du fichier n'est pas touché.
export async function previewProjectFromPath(path) {
  const text = await readTextFile(path);
  const preview = readProjectFilePreview(text, { fileName: basename(path) || path });
  if (!hasPath(preview.thumbnailImage)) return preview;
  return {
    ...preview,
    thumbnailImage: await resolveLoadedProjectPath(
      preview.thumbnailImage,
      getProjectDir(path),
      await getWorkspaceDir(),
      new Map(),
    ),
  };
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

// Relève l'existence des seuls fichiers déclarés par les liaisons médias.
// Un projet Libre n'en a pas : il ressort inchangé, sans le moindre accès disque.
async function auditMediaBindingStatuses(project) {
  const statusByPath = {};
  for (const binding of readMediaBindings(project)) {
    if (!hasPath(binding?.path) || Object.hasOwn(statusByPath, binding.path)) continue;
    statusByPath[binding.path] = await exists(binding.path).catch(() => false);
  }
  return resolveMediaBindingStatuses(project, statusByPath);
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
  // Même vue qu'au transfert : le mode Avancé copie ce que ses liaisons
  // déclarent, jamais ce que le payload d'auteur contient. Un `assetRef` reste
  // une chaîne du dialecte et n'est ni copié, ni réécrit, ni dédoublonné.
  const serializable = projectFileBody(project);
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
  // Le `status` d'une liaison est un dernier état connu, jamais un droit de
  // suppression : il est redérivé du disque après les copies, et une liaison
  // sans fichier reste liée, déclarée `missing` avec son dernier chemin connu.
  const consolidated = await auditMediaBindingStatuses(serializable);
  const projectToSave = relativizeProjectMediaPaths(consolidated, destinationDir);
  await writeProjectFileAtomic(projectPath, encodeProjectFile(projectToSave, { fileName: basename(projectPath) }));
  return { path: projectPath, project: consolidated, copiedCount, errors };
}

// Dépendances du projet qui vivent encore dans le dossier de session **et**
// existent sur le disque. Ce sont exactement les fichiers qu'un nettoyage de
// session détruirait : tant qu'il en reste un, le projet enregistré n'est pas
// autonome et la promotion ne doit pas supprimer la session. Une référence dont
// le fichier a déjà disparu n'en est pas une — un média manquant n'a jamais
// empêché un enregistrement, et le nettoyage ne lui retire rien.
export async function collectLiveSessionDependencies(project, sessionDir) {
  const bound = collectSessionBoundReferences({ project, sessionDir });
  const live = [];
  for (const dependency of bound) {
    if (await exists(dependency.path).catch(() => false)) live.push(dependency);
  }
  return live;
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

export async function autoSaveEphemeralProject(project, sessionWorkspaceDir, snapshotPath, options = {}) {
  if (!sessionWorkspaceDir || !snapshotPath) return null;
  return saveProject(project, snapshotPath, null, {
    autosave: true,
    backupLimit: 0,
    backupDirOverride: null,
    mediaTags: options.mediaTags ?? {},
    mediaLibraryPaths: options.mediaLibraryPaths ?? [],
    totalMediaCount: options.totalMediaCount ?? 0,
    workspaceDir: sessionWorkspaceDir,
  });
}

async function copyPlainMediaToWorkspace(sourcePath, baseDir, category, projectName) {
  const safeCategory = MANAGED_PROJECT_DIRS.includes(category) ? category : FICHIERS_IMPORTES;
  const targetDir = joinPath(baseDir, safeCategory);
  await mkdir(targetDir, { recursive: true });
  if (isManagedWorkspacePath(sourcePath, baseDir)) return { path: sourcePath, copied: false };
  const prefix = sanitizeProjectPrefix(projectName);
  const originalName = basename(sourcePath);
  const targetName = prefix ? `${prefix}__${originalName}` : originalName;
  const dest = await uniquePathInDir(targetDir, targetName);
  await copyFile(sourcePath, dest);
  return { path: dest, copied: true };
}

async function cleanupIncompleteImageArtifact(imagePath, dependencyPath = null) {
  const metadataPath = imageEditMetadataPath(imagePath);
  await Promise.all([
    remove(imagePath).catch(() => {}),
    metadataPath ? remove(metadataPath).catch(() => {}) : Promise.resolve(),
    dependencyPath ? remove(dependencyPath).catch(() => {}) : Promise.resolve(),
  ]);
  if (metadataPath) await remove(dirname(metadataPath)).catch(() => {});
}

// Copie atomiquement le média édité, son sidecar et la source nécessaire à une
// réédition. Le sidecar est réécrit vers la copie durable de cette source.
export async function copyMediaToWorkspace(
  sourcePath,
  workspaceDir,
  category = FICHIERS_IMPORTES,
  projectName = '',
  { artifactCopies = null, knownCopies = null } = {},
) {
  if (!hasPath(sourcePath)) return sourcePath;
  const baseDir = workspaceDir || await getWorkspaceDir();
  if (isManagedWorkspacePath(sourcePath, baseDir)) return sourcePath;
  const cachedMain = knownCopies?.get(pathKey(sourcePath));
  if (cachedMain) return cachedMain;

  const imageCopy = await copyPlainMediaToWorkspace(sourcePath, baseDir, category, projectName);
  if (!supportsImageEditMetadata(sourcePath)) {
    knownCopies?.set(pathKey(sourcePath), imageCopy.path);
    return imageCopy.path;
  }
  let copiedDependency = null;
  let dependencyCopyRecord = null;
  try {
    const sourceMetadataPath = imageEditMetadataPath(sourcePath);
    if (!sourceMetadataPath || !(await exists(sourceMetadataPath))) {
      knownCopies?.set(pathKey(sourcePath), imageCopy.path);
      return imageCopy.path;
    }
    const metadata = await readImageEditMetadata(sourcePath, { strict: true });

    let durableSourcePath;
    if (pathKey(metadata.sourcePath) === pathKey(sourcePath)) {
      durableSourcePath = imageCopy.path;
    } else {
      durableSourcePath = knownCopies?.get(pathKey(metadata.sourcePath));
      if (!durableSourcePath) {
        const dependencyCopy = await copyPlainMediaToWorkspace(
          metadata.sourcePath,
          baseDir,
          FICHIERS_IMPORTES,
          projectName,
        );
        durableSourcePath = dependencyCopy.path;
        if (dependencyCopy.copied) {
          copiedDependency = dependencyCopy.path;
          dependencyCopyRecord = { from: metadata.sourcePath, to: dependencyCopy.path };
        }
      }
    }
    await writeImageEditMetadata(
      imageCopy.path,
      withImageEditSourcePath(metadata, durableSourcePath),
      { strict: true },
    );
    knownCopies?.set(pathKey(sourcePath), imageCopy.path);
    if (dependencyCopyRecord) {
      knownCopies?.set(pathKey(dependencyCopyRecord.from), dependencyCopyRecord.to);
      artifactCopies?.push(dependencyCopyRecord);
    }
    return imageCopy.path;
  } catch (error) {
    await cleanupIncompleteImageArtifact(imageCopy.path, copiedDependency);
    throw error;
  }
}
