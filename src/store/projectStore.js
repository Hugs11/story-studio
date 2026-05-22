import { useState, useCallback, useEffect, useRef } from 'react';
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
  moveEntryToContainer,
  normalizeProjectData,
  removeEntry,
  removeEntries,
  reorderMenuVisibleChildren,
  reorderRootVisibleEntries,
  reorderTopLevelMenus,
  replaceEntryWithEntries,
  shallowCloneEntry,
  updateEntry,
  updateProjectRootEntries,
} from './projectModel';
import { normalizeNavigationTarget } from './navigationTargets';
import { logger } from '../utils/logger';

export function isTextEditingTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
}

const IMPORT_CONTROL_CHARS_REGEX = /[\u0000-\u001f\u007f]/g;
const IMPORT_FILENAME_UNSAFE_REGEX = /[<>:"/\\|?*]/g;
const IMPORT_EMOJI_REGEX = /[\p{Extended_Pictographic}\u200d\ufe0f]/gu;
const IMPORT_TRAILING_PUNCTUATION_REGEX = /^[\s._-]+|[\s._-]+$/g;
const ROOT_AUDIO_FIELDS = new Set(['rootAudio', 'nightModeAudio']);
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
  rootItems: [],
  globalOptions: {
    convertFormat: true,
    addSilence: true,
    autoNext: false,
    selectNext: false,
    nightMode: false,
    aiImageGen: false,
  },
  menus: [],
  rootEntries: [],
});

function basenameWithoutExtension(path) {
  return String(path || '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '');
}

export function sanitizeImportedName(value, fallback = '') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(IMPORT_EMOJI_REGEX, ' ')
    .replace(IMPORT_CONTROL_CHARS_REGEX, ' ')
    .replace(IMPORT_FILENAME_UNSAFE_REGEX, ' ')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(IMPORT_TRAILING_PUNCTUATION_REGEX, '')
    .trim()
    .slice(0, 120)
    .trim();

  return normalized || fallback;
}

export function sanitizeImportedEntries(entries = []) {
  return (entries ?? []).map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const fallbackName = entry.type === 'menu'
      ? 'Collection importee'
      : entry.type === 'zip'
        ? 'ZIP importe'
        : 'Histoire importee';
    const nextEntry = {
      ...entry,
      name: sanitizeImportedName(entry.name, fallbackName),
    };
    if (entry.type === 'menu' && Array.isArray(entry.children)) {
      nextEntry.children = sanitizeImportedEntries(entry.children);
    }
    return nextEntry;
  });
}

function nameFromPath(path) {
  if (!path) return '';
  return sanitizeImportedName(basenameWithoutExtension(path), '');
}

function mediaPathKey(path) {
  return String(path || '').trim().replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase();
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
  const [activeTab, setActiveTab] = useState('edit');
  const [savePath, setSavePath] = useState(null); // chemin du .mbah sauvegardé
  const historyRef = useRef([]);
  const redoRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Tags médias — state séparé (hors undo), persisté dans le .mbah
  const [mediaTags, setMediaTagsRaw] = useState({});

  // Toute modification passe par ici pour alimenter l'historique
  const setProject = useCallback((updater) => {
    setProjectRaw(prev => {
      historyRef.current = [...historyRef.current.slice(-49), prev];
      redoRef.current = [];
      setCanUndo(true);
      setCanRedo(false);
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
      setCanUndo(historyRef.current.length > 0);
      setCanRedo(true);
      return prev;
    });
  }, []);

  const redo = useCallback(() => {
    if (redoRef.current.length === 0) return;
    setProjectRaw(current => {
      const next = redoRef.current[redoRef.current.length - 1];
      redoRef.current = redoRef.current.slice(0, -1);
      historyRef.current = [...historyRef.current, current];
      setCanUndo(true);
      setCanRedo(redoRef.current.length > 0);
      return next;
    });
  }, []);

  // ── Projet ──────────────────────────────────────────────────────────────────

  const resetProject = useCallback(() => {
    historyRef.current = [];
    redoRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    setProjectRaw(DEFAULT_PROJECT);
    setSelectedId('root');
    setSavePath(null);
    setActiveTab('edit');
    setMediaTagsRaw({});
  }, []);

  const loadProject = useCallback((data) => {
    historyRef.current = [];
    redoRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
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
      const key = mediaPathKey(path);
      let changed = false;
      const next = {};
      for (const [tagPath, tags] of Object.entries(prev)) {
        if (mediaPathKey(tagPath) === key) {
          changed = true;
        } else {
          next[tagPath] = tags;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const syncProjectWithoutHistory = useCallback((data) => {
    setProjectRaw(normalizeProjectData(data));
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
    setActiveTab('edit');
    logger.info(`setProjectType: ${type}`);
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
      if (ROOT_AUDIO_FIELDS.has(field) && next.audioProcessing?.[field]) {
        next.audioProcessing = { ...next.audioProcessing };
        delete next.audioProcessing[field];
      }
      return next;
    });
  }, [setProject]);

  const updateGlobalOption = useCallback((key, value) => {
    setProject(p => ({ ...p, globalOptions: { ...p.globalOptions, [key]: value } }));
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
    setProject(p => removeEntry(p, menuId));
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
      if (menu.audio) {
        next.audioProcessing = { ...(p.audioProcessing ?? {}) };
        if (menu.audioProcessing?.audio?.skipSilence === true) {
          next.audioProcessing.rootAudio = { skipSilence: true };
        } else {
          delete next.audioProcessing.rootAudio;
        }
      }
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

  const addStory = useCallback((menuId, audioPath) => {
    const autoName = nameFromPath(audioPath);
    const newStory = createStoryEntry({
      name: autoName || 'Nouvelle histoire',
      audio: audioPath || null,
    });
    setProject(p => appendEntry(p, menuId, newStory));
    setSelectedId(newStory.id);
    return newStory.id;
  }, [setProject]);

  const addZip = useCallback((menuId, zipPath, preferredName = null, coverImage = null, coverAudio = null) => {
    const rawName = preferredName || basenameWithoutExtension(zipPath);
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
    setProject(p => removeEntries(p, ids));
    setSelectedId('root');
  }, [setProject]);

  const deleteItem = useCallback((itemId) => {
    setProject(p => removeEntry(p, itemId));
    setSelectedId('root');
  }, [setProject]);

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

  const moveItemToMenu = useCallback((itemId, fromMenuId, toMenuId, anchorId = null, insertPosition = 'inside') => {
    if (anchorId && insertPosition !== 'inside') {
      setProject(p => moveEntryNextTo(p, itemId, anchorId, insertPosition));
    } else {
      setProject(p => moveEntryToContainer(p, itemId, toMenuId));
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
    activeTab, setActiveTab,
    canUndo, undo, canRedo, redo,
    setProjectType, updateStoryAudio,
    updateProjectName, updatePackMetadata, updateRootMedia, updateGlobalOption,
    addMenu, updateMenu, deleteMenu, promoteMenuToRoot, demoteRootToMenu,
    addStory, addZip, updateItem, bulkUpdateItems, bulkDeleteItems, deleteItem, replaceZipWithEntries,
    pasteEntriesToMenu, cutPasteEntriesToMenu, duplicateEntry,
    removeMediaReferences,
    reorderMenuItems, reorderRootItems, reorderMenus, moveItemToMenu,
    getSelectedNode, getParentMenuId,
    mediaTags, setMediaTags, addMediaTag, removeMediaTag, deleteMediaTag, deleteMediaTagsForPath,
  };
}
