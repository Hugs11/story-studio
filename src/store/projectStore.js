import { useState, useCallback, useRef } from 'react';
import {
  appendEntry,
  appendEntries,
  clearMediaReferences,
  cutPasteEntries,
  createMenuEntry,
  createStoryEntry,
  createZipEntry,
  DEFAULT_PACK_METADATA,
  findEntryById,
  findParentMenuId,
  insertEntryAfter,
  moveEntryNextTo,
  moveEntriesToContainer,
  normalizeProjectData,
  removeEntryCascadingRefs,
  removeEntriesCascadingRefs,
  reorderMenuVisibleChildren,
  reorderRootVisibleEntries,
  reorderTopLevelMenus,
  replaceEntryWithEntries,
  replaceStoriesWithAssembledStory,
  shallowCloneEntry,
  updateEntry,
  updateProjectRootEntries,
} from './projectModel';
import { normalizeNavigationTarget } from './navigationTargets';
import { logger } from '../utils/logger';
import { basenameNoExt, pathKey } from '../utils/fileUtils';
import { sanitizeImportedEntries, sanitizeImportedName } from './importedNames';
import {
  attachStoryEndToGlobalProject,
  removeGlobalEndMessageProject,
  updateGlobalEndMessageProject,
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
  const [selectedId, setSelectedId] = useState('root');
  const [savePath, setSavePath] = useState(null); // chemin du .mbah sauvegardé
  const historyRef = useRef([]);
  const redoRef = useRef([]);
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
    setProjectRaw(prev => {
      historyRef.current = [...historyRef.current.slice(-(MAX_HISTORY_SIZE - 1)), prev];
      redoRef.current = [];
      const next = typeof updater === 'function' ? updater(prev) : updater;
      return normalizeProjectData(next);
    });
  }, []);

  const undo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    setProjectRaw(current => {
      const prev = historyRef.current[historyRef.current.length - 1];
      historyRef.current = historyRef.current.slice(0, -1);
      redoRef.current = [...redoRef.current, current];
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return;
    setProjectRaw(current => {
      const next = redoRef.current[redoRef.current.length - 1];
      redoRef.current = redoRef.current.slice(0, -1);
      historyRef.current = [...historyRef.current, current];
      return next;
    });
  }, []);

  // ── Projet ──────────────────────────────────────────────────────────────────

  const resetProject = useCallback(() => {
    historyRef.current = [];
    redoRef.current = [];
    setProjectRaw(DEFAULT_PROJECT);
    setSelectedId('root');
    setSavePath(null);
    setMediaTagsRaw({});
  }, []);

  const loadProject = useCallback((data) => {
    historyRef.current = [];
    redoRef.current = [];
    setProjectRaw(normalizeProjectData(data));
    setSelectedId('root');
  }, []);

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
    setProjectRaw((current) => {
      const next = normalizeProjectData(data);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, []);

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
    setProject(p => appendEntry(p, parentMenuId, newMenu));
    setSelectedId(newMenu.id);
    return newMenu.id;
  }, [setProject]);

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
    setProject(p => {
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
    setSelectedId('root');
  }, [setProject]);

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
    setProject(p => replaceEntryWithEntries(p, menuId, itemId, entries));
    setSelectedId('root');
  }, [setProject]);

  const pasteEntriesToMenu = useCallback((targetMenuId, entries) => {
    setProject(p => appendEntries(p, targetMenuId, entries));
  }, [setProject]);

  const cutPasteEntriesToMenu = useCallback((sourceIds, targetMenuId) => {
    setProject(p => cutPasteEntries(p, sourceIds, targetMenuId));
  }, [setProject]);

  const duplicateEntry = useCallback((nodeId) => {
    setProject(p => {
      const entry = findEntryById(p, nodeId);
      if (!entry) return p;
      const clone = shallowCloneEntry(entry);
      return insertEntryAfter(p, nodeId, clone);
    });
  }, [setProject]);

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
    if (itemIds.length === 0) return;
    if (itemIds.length === 1 && anchorId && insertPosition !== 'inside') {
      setProject(p => moveEntryNextTo(p, itemIds[0], anchorId, insertPosition));
    } else {
      setProject(p => moveEntriesToContainer(p, itemIds, toMenuId));
    }
  }, [setProject]);

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
    project, setProject, loadProject, resetProject, syncProjectWithoutHistory,
    savePath, setSavePath,
    selectedId, setSelectedId,
    canUndo, undo, canRedo, redo,
    setProjectType, updateStoryAudio,
    updateProjectName, updatePackMetadata, updateRootMedia, updateGlobalOption, updateGlobalEndMessage, attachStoryEndToGlobal, removeGlobalEndMessage,
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
