import { translateTree as t } from "../../i18n/treePresentation.js";
import { makeId, normalizeMenuEntry, normalizeStoryEntry, normalizeZipEntry } from './schema.js';
import { walkMediaBindingReferences } from './mediaBindings.js';

function buildProjectIndexEntries(entries, ancestors, level, index) {
  let playableCount = 0;

  for (const entry of entries ?? []) {
    const entryId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const ancestorsPath = [...ancestors];
    const parentEntry = ancestorsPath[ancestorsPath.length - 1] ?? null;
    const parentMenu = parentEntry?.type === 'menu' ? parentEntry : null;
    const path = [...ancestorsPath, entry];

    index.flatEntries.push({
      id: entry.id,
      type: entry.type,
      level,
      entry,
      path,
    });

    if (entryId) {
      index.entryById.set(entryId, entry);
      index.pathById.set(entryId, path);
      index.parentById.set(entryId, parentEntry?.id ?? null);
      index.parentMenuById.set(entryId, parentMenu?.id ?? null);
      index.entryIdCounts.set(entryId, (index.entryIdCounts.get(entryId) ?? 0) + 1);
      if (entry.type === 'menu') {
        index.menuEntries.push(entry);
      }
      if (!index.firstSimpleStory && entry.type === 'story') {
        index.firstSimpleStory = entry;
      }
    }

    let entryPlayableCount = 0;
    if (entry.type === 'menu') {
      entryPlayableCount = buildProjectIndexEntries(entry.children ?? [], path, level + 1, index);
    } else if (entry.type === 'story' || entry.type === 'zip') {
      entryPlayableCount = 1;
    }

    if (entryId) {
      index.playableDescendantCountById.set(entryId, entryPlayableCount);
    }
    playableCount += entryPlayableCount;
  }

  return playableCount;
}

export function buildProjectIndex(project) {
  const index = {
    entryById: new Map(),
    pathById: new Map(),
    parentById: new Map(),
    parentMenuById: new Map(),
    entryIdCounts: new Map(),
    playableDescendantCountById: new Map(),
    flatEntries: [],
    menuEntries: [],
    firstSimpleStory: null,
    rootPlayableCount: 0,
  };

  index.rootPlayableCount = buildProjectIndexEntries(project?.rootEntries ?? [], [], 1, index);
  return index;
}

export function extractEntry(entries, entryId) {
  for (const entry of entries) {
    if (entry.id === entryId) return entry;
    if (entry.type === 'menu') {
      const nested = extractEntry(entry.children ?? [], entryId);
      if (nested) return nested;
    }
  }
  return null;
}

function walkEntries(entries, visitor, ancestors = []) {
  for (const entry of entries ?? []) {
    visitor(entry, ancestors);
    if (entry.type === 'menu') {
      walkEntries(entry.children ?? [], visitor, [...ancestors, entry]);
    }
  }
}

export function createMenuEntry(fields = {}) {
  return normalizeMenuEntry({ name: t("tree:menu.creation.name"), ...fields });
}

export function createStoryEntry(fields = {}) {
  return normalizeStoryEntry(fields);
}

export function createZipEntry(fields = {}) {
  return normalizeZipEntry(fields);
}

export function deepCloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const cloned = { ...entry, id: makeId() };
  if (Array.isArray(cloned.children)) {
    cloned.children = cloned.children.map(deepCloneEntry);
  }
  return cloned;
}

export function findEntryById(project, entryId, projectIndex = null) {
  if (entryId === 'root') return null;
  if (projectIndex) return projectIndex.entryById.get(entryId) ?? null;
  return extractEntry(project.rootEntries ?? [], entryId);
}

export function findParentMenuId(project, entryId, projectIndex = null) {
  if (projectIndex) return projectIndex.parentMenuById.get(entryId) ?? null;
  let parentId = null;
  walkEntries(project.rootEntries ?? [], (entry, ancestors) => {
    if (entry.id === entryId) {
      const directParent = ancestors[ancestors.length - 1] ?? null;
      parentId = directParent?.type === 'menu' ? directParent.id : null;
    }
  });
  return parentId;
}


export function findEntryPath(project, entryId, projectIndex = null) {
  if (entryId === 'root') return [];
  if (projectIndex) return projectIndex.pathById.get(entryId) ?? null;

  function visit(entries, ancestors = []) {
    for (const entry of entries ?? []) {
      const path = [...ancestors, entry];
      if (entry.id === entryId) return path;
      if (entry.type === 'menu') {
        const nested = visit(entry.children ?? [], path);
        if (nested) return nested;
      }
    }
    return null;
  }

  return visit(project.rootEntries ?? []);
}

export function buildSelectedNode(project, selectedId, projectIndex = null) {
  if (selectedId === 'root') {
    const simpleStory = projectIndex?.firstSimpleStory
      ?? (project.rootEntries?.find((entry) => entry.type === 'story') ?? null);
    return { type: 'root', ...project, storyAudio: simpleStory?.audio ?? null };
  }

  const entry = findEntryById(project, selectedId, projectIndex);
  if (!entry) return null;
  if (entry.type === 'menu') {
    return {
      type: 'menu',
      ...entry,
      items: (entry.children ?? []).filter((child) => child.type !== 'menu'),
    };
  }
  return entry;
}

export function visitProjectEntries(project, visitor, projectIndex = null) {
  if (projectIndex) {
    for (const flatEntry of projectIndex.flatEntries) {
      const path = flatEntry.path ?? projectIndex.pathById.get(flatEntry.id) ?? [flatEntry.entry];
      visitor(flatEntry.entry, path.slice(0, -1));
    }
    return;
  }
  walkEntries(project.rootEntries ?? [], visitor);
}

export function collectAllMenus(project, projectIndex = null) {
  if (projectIndex) {
    return projectIndex.menuEntries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      importedContinuation: entry.importedContinuation ?? null,
    }));
  }
  const menus = [];
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'menu') {
      menus.push({
        id: entry.id,
        name: entry.name,
        importedContinuation: entry.importedContinuation ?? null,
      });
    }
  });
  return menus;
}

export function collectAllStories(project, projectIndex = null) {
  const stories = [];
  if (projectIndex) {
    for (const flat of projectIndex.flatEntries) {
      if (flat.type === 'story') {
        stories.push({
          id: flat.entry.id,
          name: flat.entry.name,
          hasAfterPlaybackHomeStep: !!flat.entry.afterPlaybackHomeStep,
        });
      }
    }
    return stories;
  }
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'story') {
      stories.push({
        id: entry.id,
        name: entry.name,
        hasAfterPlaybackHomeStep: !!entry.afterPlaybackHomeStep,
      });
    }
  });
  return stories;
}

export function getPlayableDescendantCount(projectIndex, entryId) {
  if (!projectIndex || !entryId) return 0;
  return projectIndex.playableDescendantCountById.get(entryId) ?? 0;
}


// Retourne le chemin de l'image associee a une entree (ou a la racine), avec
// la regle qui couvre tous les types : root utilise `rootImage`, menu utilise
// `image`, story utilise `itemImage`, zip utilise `coverImage`. Centralise les
// ternaires imbriques dispersés dans les composants tree/diagram.
export function getEntryThumbnailPath(entry, { rootImage = null, isRoot = false } = {}) {
  if (isRoot) return rootImage ?? null;
  if (!entry || typeof entry !== 'object') return null;
  switch (entry.type) {
    case 'menu': return entry.image ?? null;
    case 'story': return entry.itemImage ?? null;
    case 'zip': return entry.coverImage ?? null;
    default: return null;
  }
}

// Generateur unique de toutes les references media du projet.
// Yield des objets `{ obj, key, path, label, scope }` qui permettent aux
// consommateurs de muter en place (le cas `mapProjectPaths`) ou de simplement
// lister les candidats (le cas `collectTransferableProjectFiles`).
//
// `scope` est l'un de : 'root', 'advanced-asset', 'native-graph', 'menu',
// 'story', 'zip', 'story-sequence', 'story-home'. Permet aux filtres de cibler
// un sous-ensemble sans dupliquer la traversee.
//
// 'advanced-asset' est la seule branche du mode Avancé : elle parcourt les
// liaisons declarees dans `authoring.mediaBindings`, jamais le payload d'auteur
// — une chaine opaque, ou une cle `audio` ou `path` d'extension inconnue n'est
// ni une reference media, ni un candidat au transfert.
export function* walkProjectMediaReferences(project) {
  if (!project || typeof project !== 'object') return;

  yield* walkRootReferences(project);
  yield* walkMediaBindingReferences(project);
  yield* walkNativeGraphReferences(project.nativeGraph, { key: "tree:media.nativeRoot.label" });
  yield* walkEntriesMedia(project.rootEntries ?? []);
}

function* walkEntriesMedia(entries) {
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'menu') {
      yield* walkMenuReferences(entry);
      yield* walkNativeGraphReferences(entry.nativeGraph, { key: "tree:media.nativeMenu.label", params: { name: entry.name || { key: "tree:media.menu.fallback" } } });
      yield* walkEntriesMedia(entry.children ?? []);
    } else if (entry.type === 'zip') {
      yield* walkZipReferences(entry);
    } else {
      yield* walkStoryReferences(entry);
    }
  }
}

function* walkRootReferences(project) {
  if (project.rootAudio) yield { obj: project, key: 'rootAudio', path: project.rootAudio, get label() { return t("tree:media.cover.audio"); }, scope: 'root' };
  if (project.rootImage) yield { obj: project, key: 'rootImage', path: project.rootImage, get label() { return t("tree:media.cover.image"); }, scope: 'root' };
  if (project.thumbnailImage) yield { obj: project, key: 'thumbnailImage', path: project.thumbnailImage, get label() { return t("tree:media.library.image"); }, scope: 'root' };
  if (project.nightModeAudio) yield { obj: project, key: 'nightModeAudio', path: project.nightModeAudio, get label() { return t("tree:media.night.audio"); }, scope: 'root' };
}

function* walkNativeGraphReferences(graph, labelPrefix) {
  for (const stage of graph?.document?.stageNodes ?? []) {
    const stageName = stage?.name || stage?.uuid || { key: 'tree:media.stage.fallback' };
    if (stage.audio) yield { obj: stage, key: 'audio', path: stage.audio, get label() { return t("tree:media.native.audio", { group: labelPrefix, name: stageName }); }, scope: 'native-graph' };
    if (stage.image) yield { obj: stage, key: 'image', path: stage.image, get label() { return t("tree:media.native.image", { group: labelPrefix, name: stageName }); }, scope: 'native-graph' };
  }
}

function* walkMenuReferences(menu) {
  const name = menu.name || { key: "tree:media.name.fallback" };
  if (menu.audio) yield { obj: menu, key: 'audio', path: menu.audio, get label() { return t("tree:media.menu.audio", { name }); }, scope: 'menu' };
  if (menu.image) yield { obj: menu, key: 'image', path: menu.image, get label() { return t("tree:media.menu.image", { name }); }, scope: 'menu' };
}

function* walkZipReferences(zip) {
  const name = zip.name || { key: "tree:media.name.fallback" };
  if (zip.zipPath) yield { obj: zip, key: 'zipPath', path: zip.zipPath, get label() { return t("tree:media.zip.archive", { name }); }, scope: 'zip' };
  if (zip.coverImage) yield { obj: zip, key: 'coverImage', path: zip.coverImage, get label() { return t("tree:media.cover.image"); }, scope: 'zip' };
  if (zip.coverAudio) yield { obj: zip, key: 'coverAudio', path: zip.coverAudio, get label() { return t("tree:media.cover.audio"); }, scope: 'zip' };
}

function* walkStoryReferences(story) {
  const name = story.name || { key: "tree:media.name.fallback" };
  if (story.audio) yield { obj: story, key: 'audio', path: story.audio, get label() { return t("tree:media.story.audio", { name }); }, scope: 'story' };
  if (story.itemAudio) yield { obj: story, key: 'itemAudio', path: story.itemAudio, get label() { return t("tree:media.story.titleAudio", { name }); }, scope: 'story' };
  if (story.itemImage) yield { obj: story, key: 'itemImage', path: story.itemImage, get label() { return t("tree:media.story.image", { name }); }, scope: 'story' };
  if (story.afterPlaybackPromptAudio) yield { obj: story, key: 'afterPlaybackPromptAudio', path: story.afterPlaybackPromptAudio, get label() { return t("tree:media.story.endAudio", { name }); }, scope: 'story' };
  for (const [index, step] of (story.afterPlaybackSequence ?? []).entries()) {
    if (step?.audio) yield { obj: step, key: 'audio', path: step.audio, get label() { return t("tree:media.sequence.audio", { number: index + 1, name }); }, scope: 'story-sequence' };
    if (step?.image) yield { obj: step, key: 'image', path: step.image, get label() { return t("tree:media.sequence.image", { number: index + 1, name }); }, scope: 'story-sequence' };
  }
  const homeStep = story.afterPlaybackHomeStep;
  if (homeStep) {
    if (homeStep.audio) yield { obj: homeStep, key: 'audio', path: homeStep.audio, get label() { return t("tree:media.home.audio", { name }); }, scope: 'story-home' };
    if (homeStep.image) yield { obj: homeStep, key: 'image', path: homeStep.image, get label() { return t("tree:media.home.image", { name }); }, scope: 'story-home' };
  }
}
