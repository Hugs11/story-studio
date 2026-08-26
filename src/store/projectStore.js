import { useState, useCallback, useRef } from 'react';
import {
  appendEntry,
  appendEntries,
  clearMediaReferences,
  cutPasteEntries,
  deepCloneEntry,
  createMenuEntry,
  createStoryEntry,
  createZipEntry,
  DEFAULT_PACK_METADATA,
  findEntryById,
  findEntryPath,
  findParentMenuId,
  insertEntryAfter,
  moveEntryNextTo,
  moveEntriesToContainer,
  getProjectMenuDepthDiagnostic,
  MENU_DEPTH_LIMIT_CODE,
  MENU_DEPTH_LIMIT_REACHED_MESSAGE,
  normalizeProjectData,
  removeEntryCascadingRefs,
  removeEntriesCascadingRefs,
  reorderMenuVisibleChildren,
  reorderRootVisibleEntries,
  reorderTopLevelMenus,
  replaceEntryWithEntries,
  replaceStoriesWithAssembledStory,
  updateEntry,
  updateProjectRootEntries,
  validateMenuDepthMove,
  validateMenuDepthPlacement,
} from './projectModel';
import { normalizeNavigationTarget } from './navigationTargets';
import { logger } from '../utils/logger';
import { basenameNoExt, pathKey } from '../utils/fileUtils';
import { sanitizeImportedEntries, sanitizeImportedName } from './importedNames';
import {
  attachStoryEndToGlobalProject,
  removeGlobalEndMessageProject,
  updateGlobalEndMessageProject,
  updateGlobalEndPlaybackProject,
} from './endMessageMutations';

export { sanitizeImportedEntries, sanitizeImportedName };

export function isTextEditingTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
}

const MAX_HISTORY_SIZE = 50;

const ENTRY_NAVIGATION_FIELDS = [
  'returnAfterPlay',
  'returnOnHome',
  'titleReturnOnHome',
  'afterPlaybackPromptOkTarget',
  'afterPlaybackPromptHomeTarget',
];

const DEFAULT_PROJECT = normalizeProjectData({
  version: 1,
  projectName: '',
  packMetadata: DEFAULT_PACK_METADATA,
  rootName: 'Menu racine',
  endNodeName: 'Message de fin',
  projectType: null, // null = non choisi, 'simple' | 'pack'
  rootAudio: null,
  rootImage: null,
  thumbnailImage: null,
  sameImage: false,
  autoGenerateRootImage: false,
  nightModeAudio: null,
  nightModeReturn: null,
  nightModeHomeReturn: null,
  nativeGraph: null,
  globalOptions: {
    silenceMode: 'normalize',
    harmonizeLoudness: true,
    autoNext: false,
    nightMode: false,
    endMessageAutoplay: false,
    aiImageGen: false,
  },
  rootEntries: [],
});

function nameFromPath(path) {
  if (!path) return '';
  return sanitizeImportedName(basenameNoExt(path), '', { preserveHyphens: true });
}

function rewritePromotedRootTarget(target, promotedMenuId) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  return normalized === `menu:${promotedMenuId}` ? 'root' : normalized;
}

function rewritePromotedEntryNavigation(entry, promotedMenuId) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  for (const field of ENTRY_NAVIGATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      next[field] = rewritePromotedRootTarget(next[field], promotedMenuId);
    }
  }
  if (Array.isArray(next.afterPlaybackSequence)) {
    next.afterPlaybackSequence = next.afterPlaybackSequence.map((step) => ({
      ...step,
      okTarget: rewritePromotedRootTarget(step?.okTarget, promotedMenuId),
      homeTarget: rewritePromotedRootTarget(step?.homeTarget, promotedMenuId),
    }));
  }
  if (next.type === 'menu') {
    next.children = (next.children ?? []).map((child) => rewritePromotedEntryNavigation(child, promotedMenuId));
  }
  return next;
}

function applyPromotedMenuDefaultsToChild(child, promotedMenu) {
  const next = rewritePromotedEntryNavigation(child, promotedMenu.id);
  if (next.type === 'story' && !next.returnAfterPlay && promotedMenu.returnAfterPlay) {
    next.returnAfterPlay = rewritePromotedRootTarget(promotedMenu.returnAfterPlay, promotedMenu.id);
  }
  return next;
}

export function useProjectStore() {
  const [project, setProjectRaw] = useState(DEFAULT_PROJECT);
  const projectMutationRef = useRef(project);
  const [selectedId, setSelectedId] = useState('root');
  const [savePath, setSavePath] = useState(null); // chemin du .mbah sauvegardé
  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const [mutationError, setMutationError] = useState(null);
  projectMutationRef.current = project;
  // canUndo / canRedo sont des derives purs des refs : on les recalcule au
  // rendu au lieu de les stocker en state. Toute mutation des refs est suivie
  // d'un setProjectRaw qui declenche un nouveau rendu, donc les valeurs restent
  // synchronisees sans setState-dans-setState (anti-pattern React).
  const canUndo = historyRef.current.length > 0;
  const canRedo = redoRef.current.length > 0;

  // Tags médias — state séparé (hors undo), persisté dans le .mbah
  const [mediaTags, setMediaTagsRaw] = useState({});

  // Toute modification passe par ici pour alimenter l'historique
  const setProject = useCallback((updater) => {
    const current = projectMutationRef.current;
    const next = normalizeProjectData(
      typeof updater === 'function' ? updater(current) : updater,
    );
    projectMutationRef.current = next;
    setProjectRaw(prev => {
      historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY_SIZE - 1)), prev];
      redoRef.current = [];
      return next;
    });
  }, []);

  const clearMutationError = useCallback(() => setMutationError(null), []);

  const rejectMenuDepthMutation = useCallback((diagnostic) => {
    const rejection = {
      ...diagnostic,
      code: MENU_DEPTH_LIMIT_CODE,
      message: MENU_DEPTH_LIMIT_REACHED_MESSAGE,
    };
    setMutationError(rejection);
    return rejection;
  }, []);

  const commitDepthMutation = useCallback((diagnostic, buildNextProject) => {
    if (!diagnostic.allowed) return rejectMenuDepthMutation(diagnostic);
    const current = projectMutationRef.current;
    const next = buildNextProject(current);
    const finalDiagnostic = getProjectMenuDepthDiagnostic(next);
    if (!finalDiagnostic.allowed) return rejectMenuDepthMutation(finalDiagnostic);
    projectMutationRef.current = next;
    setProject(next);
    return { ...finalDiagnostic, project: next };
  }, [rejectMenuDepthMutation, setProject]);

  const setProjectWithDepthGuard = useCallback((updater) => {
    const current = projectMutationRef.current;
    const next = typeof updater === 'function' ? updater(current) : updater;
    const diagnostic = getProjectMenuDepthDiagnostic(next);
    return commitDepthMutation(diagnostic, () => next);
  }, [commitDepthMutation]);

  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    setProjectRaw(current => {
      const prev = historyRef.current[historyRef.current.length - 1];
      historyRef.current = historyRef.current.slice(0, -1);
      redoRef.current = [...redoRef.current, current];
      projectMutationRef.current = prev;
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return;
    setProjectRaw(current => {
      const next = redoRef.current[redoRef.current.length - 1];
      redoRef.current = redoRef.current.slice(0, -1);
      historyRef.current = [...historyRef.current, current];
      projectMutationRef.current = next;
      return next;
    });
  }, []);

  // ── Projet ──────────────────────────────────────────────────────────────────

  const resetProject = useCallback(() => {
    historyRef.current = [];
    redoRef.current = [];
    setProjectRaw(DEFAULT_PROJECT);
    projectMutationRef.current = DEFAULT_PROJECT;
    setSelectedId('root');
    setSavePath(null);
    setMediaTagsRaw({});
  }, []);

  const loadProject = useCallback((data) => {
    const diagnostic = getProjectMenuDepthDiagnostic(data);
    if (!diagnostic.allowed) return rejectMenuDepthMutation(diagnostic);
    historyRef.current = [];
    redoRef.current = [];
    const normalized = normalizeProjectData(data);
    projectMutationRef.current = normalized;
    setProjectRaw(normalized);
    setSelectedId('root');
    return { ...diagnostic, project: normalized };
  }, [rejectMenuDepthMutation]);

  const setMediaTags = useCallback((tags) => {
    setMediaTagsRaw(tags && typeof tags === 'object' ? tags : {});
  }, []);

  const addMediaTag = useCallback((path, tag) => {
    if (!path || !tag?.trim()) return;
    const t = tag.trim();
    setMediaTagsRaw(prev => {
      const current = prev[path] ?? [];
      if (current.includes(t)) return prev;
      return { ...prev, [path]: [...current, t] };
    });
  }, []);

  const removeMediaTag = useCallback((path, tag) => {
    setMediaTagsRaw(prev => {
      const current = prev[path] ?? [];
      const next = current.filter(t => t !== tag);
      if (next.length === 0) {
        const { [path]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [path]: next };
    });
  }, []);

  const deleteMediaTag = useCallback((tag) => {
    setMediaTagsRaw(prev => {
      const next = {};
      for (const [p, tags] of Object.entries(prev)) {
        const filtered = tags.filter(t => t !== tag);
        if (filtered.length > 0) next[p] = filtered;
      }
      return next;
    });
  }, []);

  const deleteMediaTagsForPath = useCallback((path) => {
    if (!path) return;
    setMediaTagsRaw(prev => {
      const key = pathKey(path);
      let changed = false;
      const next = {};
      for (const [tagPath, tags] of Object.entries(prev)) {
        if (pathKey(tagPath) === key) {
          changed = true;
        } else {
          next[tagPath] = tags;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const syncProjectWithoutHistory = useCallback((data) => {
    const diagnostic = getProjectMenuDepthDiagnostic(data);
    if (!diagnostic.allowed) return rejectMenuDepthMutation(diagnostic);
    const next = normalizeProjectData(data);
    projectMutationRef.current = next;
    setProjectRaw((current) => {
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
    return diagnostic;
  }, [rejectMenuDepthMutation]);

  const setProjectType = useCallback((type) => {
    setProject(p => {
      if (type === 'simple') {
        const firstStory = p.rootEntries.find((entry) => entry.type === 'story')
          ?? p.rootEntries.find((entry) => entry.type === 'menu')?.children?.find((entry) => entry.type === 'story')
          ?? createStoryEntry({ name: '' });
        return updateProjectRootEntries({ ...p, projectType: type }, [firstStory]);
      }
      return updateProjectRootEntries({ ...p, projectType: type }, p.rootEntries ?? []);
    });
    logger.info(`project:set-type type=${type}`);
  }, [setProject]);

  const updateStoryAudio = useCallback((audio) => {
    setProject(p => {
      const simpleStoryId = p.rootEntries?.[0]?.id;
      if (!simpleStoryId) return p;
      return updateEntry(p, simpleStoryId, { audio });
    });
  }, [setProject]);

  const updateProjectName = useCallback((name) => {
    setProject(p => ({ ...p, projectName: name }));
  }, [setProject]);

  const updatePackMetadata = useCallback((fields) => {
    setProject(p => ({
      ...p,
      packMetadata: {
        ...(p.packMetadata ?? DEFAULT_PACK_METADATA),
        ...(fields ?? {}),
      },
    }));
  }, [setProject]);

  const updateRootMedia = useCallback((field, value) => {
    setProject(p => {
      const next = { ...p, [field]: value };
      return next;
    });
  }, [setProject]);

  const updateGlobalOption = useCallback((key, value) => {
    setProject(p => ({ ...p, globalOptions: { ...p.globalOptions, [key]: value } }));
  }, [setProject]);

  // Une modification du message global et de ses projections liees est une
  // mutation unique : undo restaure donc toujours un etat coherent.
  const updateGlobalEndMessage = useCallback((fields) => {
    setProject((project) => updateGlobalEndMessageProject(project, fields));
  }, [setProject]);

  const updateGlobalEndPlayback = useCallback((autoplay) => {
    setProject((project) => updateGlobalEndPlaybackProject(project, autoplay));
  }, [setProject]);

  const addGlobalEndMessage = useCallback(() => {
    setProject((project) => ({
      ...project,
      globalOptions: {
        ...project.globalOptions,
        endNode: true,
        endMessageAutoplay: false,
      },
    }));
  }, [setProject]);

  const attachStoryEndToGlobal = useCallback((storyId) => {
    setProject((project) => attachStoryEndToGlobalProject(project, storyId));
  }, [setProject]);

  const removeGlobalEndMessage = useCallback(() => {
    setProject(removeGlobalEndMessageProject);
    setSelectedId('root');
  }, [setProject]);

  // ── Menus ─────────────────────────────────────────────────────────────────

  const addMenu = useCallback((parentMenuId = null) => {
    const newMenu = createMenuEntry();
    const current = projectMutationRef.current;
    const diagnostic = validateMenuDepthPlacement(current, parentMenuId, [newMenu]);
    const outcome = commitDepthMutation(
      diagnostic,
      (value) => appendEntry(value, parentMenuId, newMenu),
    );
    if (!outcome.allowed) return null;
    setSelectedId(newMenu.id);
    return newMenu.id;
  }, [commitDepthMutation]);

  const updateMenu = useCallback((menuId, fields) => {
    setProject(p => updateEntry(p, menuId, fields));
  }, [setProject]);

  const deleteMenu = useCallback((menuId) => {
    setProject(p => removeEntryCascadingRefs(p, menuId));
    setSelectedId('root');
  }, [setProject]);

  const promoteMenuToRoot = useCallback((menuId) => {
    setProject(p => {
      const menu = (p.rootEntries ?? []).find(e => e.id === menuId);
      if (!menu) return p;
      const rest = (p.rootEntries ?? []).filter(e => e.id !== menuId);
      const promotedChildren = (menu.children ?? []).map((child) => applyPromotedMenuDefaultsToChild(child, menu));
      const promotedRest = rest.map((entry) => rewritePromotedEntryNavigation(entry, menu.id));
      const promoted = [...promotedChildren, ...promotedRest];
      const promotedName = typeof menu.name === 'string' ? menu.name.trim() : '';
      const next = {
        ...p,
        ...(promotedName && p.projectType === 'pack'
          ? { packMetadata: { ...(p.packMetadata ?? DEFAULT_PACK_METADATA), title: promotedName, namingMode: 'convention' } }
          : {}),
        rootAudio: menu.audio ?? p.rootAudio,
        rootImage: menu.image ?? p.rootImage,
        thumbnailImage: p.thumbnailImage ?? menu.image ?? p.rootImage,
        sameImage: p.sameImage || (!p.thumbnailImage && !!(menu.image ?? p.rootImage)),
        nightModeReturn: rewritePromotedRootTarget(p.nightModeReturn, menu.id),
        nightModeHomeReturn: rewritePromotedRootTarget(p.nightModeHomeReturn, menu.id),
        nativeGraph: menu.nativeGraph ?? p.nativeGraph ?? null,
      };
      return updateProjectRootEntries(
        next,
        promoted
      );
    });
    setSelectedId('root');
  }, [setProject]);

  const demoteRootToMenu = useCallback(() => {
    const current = projectMutationRef.current;
    const candidateMenu = { type: 'menu', children: current.rootEntries ?? [] };
    const diagnostic = validateMenuDepthPlacement(current, null, [candidateMenu]);
    const outcome = commitDepthMutation(diagnostic, (p) => {
      const currentEntries = p.rootEntries ?? [];
      if (!currentEntries.length) return p;
      const newMenu = createMenuEntry({
        name: p.rootName || p.packMetadata?.title || p.projectName || 'Pack',
        audio: p.rootAudio ?? null,
        image: p.rootImage ?? null,
        children: currentEntries,
      });
      return {
        ...p,
        rootAudio: null,
        rootImage: null,
        thumbnailImage: null,
        sameImage: false,
        rootEntries: [newMenu],
      };
    });
    if (!outcome.allowed) return outcome;
    setSelectedId('root');
    return outcome;
  }, [commitDepthMutation]);

  // ── Items ─────────────────────────────────────────────────────────────────

  const addStory = useCallback((menuId, audioPath, options = {}) => {
    const autoName = nameFromPath(audioPath);
    const explicitName = typeof options.name === 'string' ? options.name.trim() : '';
    const hasImportedAudio = !!audioPath;
    const newStory = createStoryEntry({
      name: explicitName || autoName || 'Nouvelle histoire',
      audio: audioPath || null,
      ...(hasImportedAudio
        ? {
            controlSettings: {
              autoplay: true,
              wheel: false,
              pause: true,
              ok: false,
              home: true,
            },
            ...(menuId ? {} : { returnAfterPlay: 'root' }),
          }
        : {}),
    });
    setProject(p => appendEntry(p, menuId, newStory));
    setSelectedId(newStory.id);
    return newStory.id;
  }, [setProject]);

  const addZip = useCallback((menuId, zipPath, preferredName = null, coverImage = null, coverAudio = null) => {
    const rawName = preferredName || basenameNoExt(zipPath);
    const name = sanitizeImportedName(rawName, 'ZIP importe');
    const newZip = createZipEntry({ name, zipPath: zipPath || null, coverImage, coverAudio });
    setProject(p => appendEntry(p, menuId, newZip));
    setSelectedId(newZip.id);
    return newZip.id;
  }, [setProject]);

  const updateItem = useCallback((itemId, fields) => {
    setProject(p => updateEntry(p, itemId, fields));
  }, [setProject]);

  const bulkUpdateItems = useCallback((ids, getFields) => {
    setProject(p => {
      let result = p;
      for (const id of ids) {
        const entry = findEntryById(result, id);
        if (entry) result = updateEntry(result, id, getFields(entry));
      }
      return result;
    });
  }, [setProject]);

  const bulkDeleteItems = useCallback((ids) => {
    setProject(p => removeEntriesCascadingRefs(p, ids));
    setSelectedId('root');
  }, [setProject]);

  const deleteItem = useCallback((itemId) => {
    setProject(p => removeEntryCascadingRefs(p, itemId));
    setSelectedId('root');
  }, [setProject]);

  const replaceStoriesWithAssembly = useCallback((options) => {
    const outcome = replaceStoriesWithAssembledStory(project, options);
    if (!outcome.ok) return outcome;
    setProject(outcome.project);
    setSelectedId(outcome.retainedId);
    return outcome;
  }, [project, setProject]);

  // Remplace un ZIP par des entrées éditables (story/menu) issues de l'extraction
  const replaceZipWithEntries = useCallback((menuId, itemId, entries) => {
    const current = projectMutationRef.current;
    const diagnostic = validateMenuDepthPlacement(current, menuId, entries);
    const outcome = commitDepthMutation(
      diagnostic,
      (value) => replaceEntryWithEntries(value, menuId, itemId, entries),
    );
    if (!outcome.allowed) return outcome;
    setSelectedId('root');
    return outcome;
  }, [commitDepthMutation]);

  const pasteEntriesToMenu = useCallback((targetMenuId, entries) => {
    const current = projectMutationRef.current;
    const diagnostic = validateMenuDepthPlacement(current, targetMenuId, entries);
    return commitDepthMutation(
      diagnostic,
      (value) => appendEntries(value, targetMenuId, entries),
    );
  }, [commitDepthMutation]);

  const cutPasteEntriesToMenu = useCallback((sourceIds, targetMenuId) => {
    const current = projectMutationRef.current;
    const targetPath = targetMenuId == null ? [] : (findEntryPath(current, targetMenuId) ?? []);
    if (targetPath.some((entry) => sourceIds.includes(entry.id))) {
      return { allowed: false, code: 'menu_cycle' };
    }
    const diagnostic = validateMenuDepthMove(current, sourceIds, targetMenuId);
    return commitDepthMutation(
      diagnostic,
      (value) => cutPasteEntries(value, sourceIds, targetMenuId),
    );
  }, [commitDepthMutation]);

  const duplicateEntry = useCallback((nodeId) => {
    const current = projectMutationRef.current;
    const entry = findEntryById(current, nodeId);
    if (!entry) return { allowed: false, code: 'entry_missing' };
    const parentMenuId = findParentMenuId(current, nodeId);
    // La duplication d'un Dossier conserve réellement tout son sous-arbre ; la
    // garde de placement est donc calculée sur cette copie complète.
    const clone = deepCloneEntry(entry);
    const diagnostic = validateMenuDepthPlacement(current, parentMenuId, [clone]);
    return commitDepthMutation(
      diagnostic,
      (value) => insertEntryAfter(value, nodeId, clone),
    );
  }, [commitDepthMutation]);

  const removeMediaReferences = useCallback((path) => {
    setProject(p => clearMediaReferences(p, path));
  }, [setProject]);

  const reorderMenuItems = useCallback((menuId, newItems) => {
    setProject(p => reorderMenuVisibleChildren(p, menuId, newItems));
  }, [setProject]);

  const reorderRootItems = useCallback((newItems) => {
    setProject(p => reorderRootVisibleEntries(p, newItems));
  }, [setProject]);

  const reorderMenus = useCallback((newMenus) => {
    setProject(p => reorderTopLevelMenus(p, newMenus));
  }, [setProject]);

  const moveItemToMenu = useCallback((itemIdOrIds, fromMenuId, toMenuId, anchorId = null, insertPosition = 'inside') => {
    const itemIds = Array.isArray(itemIdOrIds) ? itemIdOrIds : [itemIdOrIds];
    if (itemIds.length === 0) return { allowed: false, code: 'empty_selection' };
    const current = projectMutationRef.current;
    const targetPath = toMenuId == null ? [] : (findEntryPath(current, toMenuId) ?? []);
    if (targetPath.some((entry) => itemIds.includes(entry.id))) {
      return { allowed: false, code: 'menu_cycle' };
    }
    const diagnostic = validateMenuDepthMove(current, itemIds, toMenuId);
    if (itemIds.length === 1 && anchorId && insertPosition !== 'inside') {
      return commitDepthMutation(
        diagnostic,
        (value) => moveEntryNextTo(value, itemIds[0], anchorId, insertPosition),
      );
    }
    return commitDepthMutation(
      diagnostic,
      (value) => moveEntriesToContainer(value, itemIds, toMenuId),
    );
  }, [commitDepthMutation]);

  // ── Sélection ─────────────────────────────────────────────────────────────

  const getSelectedNode = useCallback(() => {
    if (selectedId === 'root') {
      const simpleStory = project.rootEntries?.find((entry) => entry.type === 'story') ?? null;
      return { type: 'root', ...project, storyAudio: simpleStory?.audio ?? null };
    }
    const entry = findEntryById(project, selectedId);
    if (!entry) return null;
    if (entry.type === 'menu') {
      return {
        type: 'menu',
        ...entry,
        items: (entry.children ?? []).filter((child) => child.type !== 'menu'),
      };
    }
    return entry;
  }, [selectedId, project]);

  const getParentMenuId = useCallback((itemId) => {
    return findParentMenuId(project, itemId);
  }, [project]);

  return {
    project, setProject, setProjectWithDepthGuard, loadProject, resetProject, syncProjectWithoutHistory,
    mutationError, clearMutationError,
    savePath, setSavePath,
    selectedId, setSelectedId,
    canUndo, undo, canRedo, redo,
    setProjectType, updateStoryAudio,
    updateProjectName, updatePackMetadata, updateRootMedia, updateGlobalOption, updateGlobalEndMessage, updateGlobalEndPlayback, addGlobalEndMessage, attachStoryEndToGlobal, removeGlobalEndMessage,
    addMenu, updateMenu, deleteMenu, promoteMenuToRoot, demoteRootToMenu,
    addStory, addZip, updateItem, bulkUpdateItems, bulkDeleteItems, deleteItem, replaceZipWithEntries,
    replaceStoriesWithAssembly,
    pasteEntriesToMenu, cutPasteEntriesToMenu, duplicateEntry,
    removeMediaReferences,
    reorderMenuItems, reorderRootItems, reorderMenus, moveItemToMenu,
    getSelectedNode, getParentMenuId,
    mediaTags, setMediaTags, addMediaTag, removeMediaTag, deleteMediaTag, deleteMediaTagsForPath,
  };
}
