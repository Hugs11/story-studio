import { makeId, normalizeMenuEntry, normalizeRefEntry, normalizeStoryEntry, normalizeZipEntry } from './schema.js';
import { refTargetEntryId } from '../navigationTargets.js';

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
  return normalizeMenuEntry({ name: 'Nouveau dossier', ...fields });
}

export function createStoryEntry(fields = {}) {
  return normalizeStoryEntry(fields);
}

export function createZipEntry(fields = {}) {
  return normalizeZipEntry(fields);
}

// Crée un nœud `ref` (« → nœud existant ») pointant vers une cible typée.
// `target` réutilise l'encodage navigation (menu:/story:/story_play:/story_home_step:).
export function createRefEntry({ target, refKind = 'continue', label = '' } = {}) {
  return normalizeRefEntry({ target, refKind, label });
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
      const path = projectIndex.pathById.get(flatEntry.id) ?? [flatEntry.entry];
      visitor(flatEntry.entry, path.slice(0, -1));
    }
    return;
  }
  walkEntries(project.rootEntries ?? [], visitor);
}

// Ids de l'entrée + tout son sous-arbre (ce qui disparaît si on la supprime).
export function collectEntrySubtreeIds(entry) {
  const ids = new Set();
  const walk = (node) => {
    if (!node?.id) return;
    ids.add(node.id);
    (node.children ?? []).forEach(walk);
  };
  walk(entry);
  return ids;
}

// Refs ENTRANTES qui deviendraient pendantes si on supprimait `entryId` (et son sous-arbre).
// Garde-fou authoring : on ne laisse pas une `ref` viser une cible disparue (cf. validation).
// Les refs situées DANS le sous-arbre supprimé ne comptent pas (elles partent avec lui).
export function findIncomingRefs(project, entryId, projectIndex = null) {
  const target = findEntryById(project, entryId, projectIndex);
  if (!target) return [];
  const removedIds = collectEntrySubtreeIds(target);
  const incoming = [];
  visitProjectEntries(project, (entry) => {
    if (entry.type !== 'ref' || removedIds.has(entry.id)) return;
    const targetId = refTargetEntryId(entry.target);
    if (targetId && removedIds.has(targetId)) incoming.push(entry);
  }, projectIndex);
  return incoming;
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
  walkEntries(project.rootEntries ?? [], (entry) => {
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
  walkEntries(project.rootEntries ?? [], (entry) => {
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

export function collectProjectAudioPaths(project) {
  const audioPaths = [];
  if (project.rootAudio) audioPaths.push(project.rootAudio);
  if (project.nightModeAudio) audioPaths.push(project.nightModeAudio);
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'menu' && entry.audio) audioPaths.push(entry.audio);
    if (entry.type === 'story') {
      if (entry.audio) audioPaths.push(entry.audio);
      if (entry.itemAudio) audioPaths.push(entry.itemAudio);
      if (entry.afterPlaybackPromptAudio) audioPaths.push(entry.afterPlaybackPromptAudio);
      for (const step of entry.afterPlaybackSequence ?? []) {
        if (step.audio) audioPaths.push(step.audio);
      }
      if (entry.afterPlaybackHomeStep?.audio) audioPaths.push(entry.afterPlaybackHomeStep.audio);
    }
  });
  return audioPaths;
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
// `scope` est l'un de : 'root', 'native-graph', 'menu', 'story', 'zip',
// 'story-sequence', 'story-home'. Permet aux filtres de cibler un sous-ensemble
// sans dupliquer la traversee.
export function* walkProjectMediaReferences(project) {
  if (!project || typeof project !== 'object') return;

  yield* walkRootReferences(project);
  yield* walkNativeGraphReferences(project.nativeGraph, 'graphe natif (racine)');
  yield* walkEntriesMedia(project.rootEntries ?? []);
}

function* walkEntriesMedia(entries) {
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type === 'menu') {
      yield* walkMenuReferences(entry);
      yield* walkNativeGraphReferences(entry.nativeGraph, `graphe natif: ${entry.name || 'menu'}`);
      yield* walkEntriesMedia(entry.children ?? []);
    } else if (entry.type === 'zip') {
      yield* walkZipReferences(entry);
    } else {
      yield* walkStoryReferences(entry);
    }
  }
}

function* walkRootReferences(project) {
  if (project.rootAudio) yield { obj: project, key: 'rootAudio', path: project.rootAudio, label: 'Audio de couverture', scope: 'root' };
  if (project.rootImage) yield { obj: project, key: 'rootImage', path: project.rootImage, label: 'Image de couverture', scope: 'root' };
  if (project.thumbnailImage) yield { obj: project, key: 'thumbnailImage', path: project.thumbnailImage, label: 'Image bibliothèque', scope: 'root' };
  if (project.nightModeAudio) yield { obj: project, key: 'nightModeAudio', path: project.nightModeAudio, label: 'Audio mode nuit', scope: 'root' };
}

function* walkNativeGraphReferences(graph, labelPrefix) {
  for (const stage of graph?.document?.stageNodes ?? []) {
    const stageName = stage?.name || stage?.uuid || 'stage';
    if (stage.audio) yield { obj: stage, key: 'audio', path: stage.audio, label: `Audio ${labelPrefix}: ${stageName}`, scope: 'native-graph' };
    if (stage.image) yield { obj: stage, key: 'image', path: stage.image, label: `Image ${labelPrefix}: ${stageName}`, scope: 'native-graph' };
  }
}

function* walkMenuReferences(menu) {
  const name = menu.name || 'sans nom';
  if (menu.audio) yield { obj: menu, key: 'audio', path: menu.audio, label: `Audio menu: ${name}`, scope: 'menu' };
  if (menu.image) yield { obj: menu, key: 'image', path: menu.image, label: `Image menu: ${name}`, scope: 'menu' };
}

function* walkZipReferences(zip) {
  const name = zip.name || 'sans nom';
  if (zip.zipPath) yield { obj: zip, key: 'zipPath', path: zip.zipPath, label: `ZIP: ${name}`, scope: 'zip' };
}

function* walkStoryReferences(story) {
  const name = story.name || 'sans nom';
  if (story.audio) yield { obj: story, key: 'audio', path: story.audio, label: `Audio histoire: ${name}`, scope: 'story' };
  if (story.itemAudio) yield { obj: story, key: 'itemAudio', path: story.itemAudio, label: `Titre audio: ${name}`, scope: 'story' };
  if (story.itemImage) yield { obj: story, key: 'itemImage', path: story.itemImage, label: `Image histoire: ${name}`, scope: 'story' };
  if (story.afterPlaybackPromptAudio) yield { obj: story, key: 'afterPlaybackPromptAudio', path: story.afterPlaybackPromptAudio, label: `Audio fin histoire: ${name}`, scope: 'story' };
  for (const [index, step] of (story.afterPlaybackSequence ?? []).entries()) {
    if (step?.audio) yield { obj: step, key: 'audio', path: step.audio, label: `Audio fin histoire ${index + 1}: ${name}`, scope: 'story-sequence' };
    if (step?.image) yield { obj: step, key: 'image', path: step.image, label: `Image fin histoire ${index + 1}: ${name}`, scope: 'story-sequence' };
  }
  const homeStep = story.afterPlaybackHomeStep;
  if (homeStep) {
    if (homeStep.audio) yield { obj: homeStep, key: 'audio', path: homeStep.audio, label: `Audio fin histoire home: ${name}`, scope: 'story-home' };
    if (homeStep.image) yield { obj: homeStep, key: 'image', path: homeStep.image, label: `Image fin histoire home: ${name}`, scope: 'story-home' };
  }
}
