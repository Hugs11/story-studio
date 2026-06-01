import {
  NAV_TARGET_NEXT_STORY,
  decodeNavigationMenuId,
  decodeNavigationStoryId,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryHomeStepNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
  normalizeNavigationTarget,
} from './navigationTargets.js';
import { pathKey } from '../utils/fileUtils.js';

export const CONTEXTUAL_NEXT_STORY_TARGET = '__contextual_next_story__';

export function hasVisibleEndNode(project) {
  return !!(
    project?.nightModeAudio
    || project?.globalOptions?.nightMode
    || project?.globalOptions?.endNode
  );
}

export function hasGeneratedEndNode(project) {
  return !!project?.nightModeAudio;
}

export function getDefaultPackEntryDestination(project) {
  const firstEntry = project?.rootEntries?.[0];
  if (!firstEntry?.id) return null;
  return {
    id: firstEntry.id,
    name: firstEntry.name || '(sans nom)',
    type: firstEntry.type,
  };
}

export function resolveNavigationTargetId(target, parentMenu = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isCurrentMenuNavigationTarget(normalized)) return parentMenu?.id ?? null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isNextStoryNavigationTarget(normalized)) return NAV_TARGET_NEXT_STORY;
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

export function getGeneratedNavigationTargetName(targetId, projectIndex, fallback = 'destination introuvable') {
  if (targetId === 'root') return 'Racine';
  if (targetId === NAV_TARGET_NEXT_STORY) return 'Histoire suivante';
  if (targetId === CONTEXTUAL_NEXT_STORY_TARGET) return "Histoire suivante selon l'histoire source";
  if (!targetId) return fallback;
  if (isStoryNavigationTarget(targetId)) {
    const storyId = decodeNavigationStoryId(targetId);
    const name = projectIndex?.entryById?.get(storyId)?.name || fallback;
    if (isStoryHomeStepNavigationTarget(targetId)) return `Retour de fin - ${name}`;
    if (isStoryPlayNavigationTarget(targetId)) return `Lecture directe - ${name}`;
    return name;
  }
  return projectIndex?.entryById?.get(targetId)?.name || fallback;
}

function findNextStorySibling(entry, parentMenu, rootEntries) {
  if (!entry) return null;
  const siblings = parentMenu ? (parentMenu.children ?? []) : (rootEntries ?? []);
  const currentIndex = siblings.findIndex((candidate) => candidate.id === entry.id);
  if (currentIndex < 0) return null;
  return siblings.slice(currentIndex + 1).find((candidate) => candidate.type === 'story') ?? null;
}

function getGeneratedTargetForEntry(entry) {
  if (!entry?.id) return null;
  return entry.type === 'story' ? `story:${entry.id}` : entry.id;
}

function getRootEntryFallbackTarget(entry, rootEntries) {
  const rootEntry = (rootEntries ?? []).find((candidate) => candidate.id === entry?.id);
  return getGeneratedTargetForEntry(rootEntry) ?? 'root';
}

function getInheritedReturnTarget(entry, parentMenu, rootEntries) {
  if (!parentMenu) return null;
  const normalized = normalizeNavigationTarget(parentMenu.returnAfterPlay);
  if (!normalized) return parentMenu.id;
  if (isNextStoryNavigationTarget(normalized)) {
    const nextStory = findNextStorySibling(entry, parentMenu, rootEntries);
    return nextStory ? `story:${nextStory.id}` : parentMenu.id;
  }
  return resolveNavigationTargetId(normalized, parentMenu) ?? parentMenu.id;
}

function getStoryFallbackReturnTarget(entry, parentMenu, rootEntries) {
  return parentMenu
    ? getInheritedReturnTarget(entry, parentMenu, rootEntries)
    : getRootEntryFallbackTarget(entry, rootEntries);
}

// Mirrors `native_pack.rs:2092-2105` : quand `globalOptions.autoNext` est actif
// ET ni la story ni le menu n'ont d'override `returnAfterPlay`, la story revient
// directement sur la story sœur suivante (pas sur le menu).
function getAutoNextFallbackTarget(entry, parentMenu, project) {
  if (!project?.globalOptions?.autoNext) return null;
  if (!parentMenu) return null;
  if (entry?.returnAfterPlay) return null;
  if (parentMenu.returnAfterPlay) return null;
  const siblings = parentMenu.children ?? [];
  const idx = siblings.findIndex((s) => s.id === entry?.id);
  if (idx < 0) return null;
  const next = siblings.slice(idx + 1).find((s) => s.type === 'story');
  return next ? `story_play:${next.id}` : null;
}

export function resolveGeneratedTargetForStory(target, entry, parentMenu, rootEntries, fallbackTarget = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return fallbackTarget;
  if (isNextStoryNavigationTarget(normalized)) {
    const nextStory = findNextStorySibling(entry, parentMenu, rootEntries);
    return nextStory ? `story:${nextStory.id}` : fallbackTarget;
  }
  return resolveNavigationTargetId(normalized, parentMenu);
}

function resolveGeneratedEndNodeTarget(target, entry, parentMenu, rootEntries, fallbackTarget = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return fallbackTarget;
  if (isNextStoryNavigationTarget(normalized)) {
    if (!entry) return CONTEXTUAL_NEXT_STORY_TARGET;
    const nextStory = findNextStorySibling(entry, parentMenu, rootEntries);
    return nextStory ? `story:${nextStory.id}` : fallbackTarget;
  }
  return resolveNavigationTargetId(normalized, parentMenu);
}

export function isCombinedNightStoryBypass(entry, project) {
  return !!(
    project?.nightModeAudio
    && entry?.type === 'story'
    && !entry?.titleControlSettings
    && entry.itemAudio === entry.audio
    && entry?.controlSettings?.wheel === true
    && entry?.controlSettings?.autoplay === true
    && entry?.returnAfterPlay
  );
}

export function isImportedNightPrompt(entry, parentMenu, project, rootEntries) {
  if (!project?.nightModeAudio || !project?.nightModeReturn || entry?.type !== 'story') return false;
  if (!entry?.afterPlaybackPromptAudio || (entry?.afterPlaybackSequence?.length ?? 0) > 0) return false;
  const promptAudio = pathKey(entry.afterPlaybackPromptAudio);
  const nightAudio = pathKey(project.nightModeAudio);
  if (!promptAudio || promptAudio !== nightAudio) return false;
  const autoNextFallback = getAutoNextFallbackTarget(entry, parentMenu, project);
  const fallbackTarget = autoNextFallback ?? getStoryFallbackReturnTarget(entry, parentMenu, rootEntries);
  const directReturnTarget = resolveGeneratedTargetForStory(
    entry.returnAfterPlay,
    entry,
    parentMenu,
    rootEntries,
    fallbackTarget,
  );
  const promptTarget = resolveGeneratedTargetForStory(
    entry.afterPlaybackPromptOkTarget,
    entry,
    parentMenu,
    rootEntries,
    directReturnTarget,
  );
  const nightTarget = resolveGeneratedEndNodeTarget(
    project.nightModeReturn,
    entry,
    parentMenu,
    rootEntries,
    directReturnTarget,
  );
  return !!promptTarget && promptTarget === nightTarget;
}

export function getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries) {
  const hasPrompt = !!entry?.afterPlaybackPromptAudio;
  const hasSequence = (entry?.afterPlaybackSequence?.length ?? 0) > 0;
  // Le fallback story doit refléter `auto_next` Rust avant tout autre calcul.
  const autoNextFallback = getAutoNextFallbackTarget(entry, parentMenu, project);
  const fallbackReturnTarget = autoNextFallback ?? getStoryFallbackReturnTarget(entry, parentMenu, rootEntries);
  const directReturnTarget = resolveGeneratedTargetForStory(
    entry?.returnAfterPlay,
    entry,
    parentMenu,
    rootEntries,
    fallbackReturnTarget,
  );
  const inheritedReturnTarget = getInheritedReturnTarget(entry, parentMenu, rootEntries);
  const usesEndNode = !!(
    project?.nightModeAudio
    && entry?.type === 'story'
    && !hasPrompt
    && !hasSequence
    && !isCombinedNightStoryBypass(entry, project)
  );
  const importedNightPrompt = isImportedNightPrompt(entry, parentMenu, project, rootEntries);
  // Cible explicitement configurée sur le nœud de fin (null si l'utilisateur
  // n'a rien défini — équivalent du `raw_return.is_none()` Rust).
  const endNodeConfiguredTargetId = (usesEndNode || importedNightPrompt) && project?.nightModeReturn
    ? resolveGeneratedEndNodeTarget(project.nightModeReturn, entry, parentMenu, rootEntries, directReturnTarget)
    : null;
  // Cible réellement générée par Rust pour cette histoire : si `nightModeReturn` est vide,
  // le `compute_night_bridge_targets` Rust retombe sur le `fallback_return` propre à la
  // story (`native_pack.rs:2624-2630`). Le fallback Rust passé à cette fonction est le
  // `play_return_transition` calculé par story, dont l'équivalent JS est `directReturnTarget`.
  const endNodeEffectiveTargetId = (usesEndNode || importedNightPrompt)
    ? (endNodeConfiguredTargetId ?? directReturnTarget)
    : null;
  const homeTarget = entry?.returnOnHome
    ? resolveGeneratedTargetForStory(entry.returnOnHome, entry, parentMenu, rootEntries, directReturnTarget)
    : null;
  const promptOkTarget = hasPrompt
    ? resolveGeneratedTargetForStory(
      entry.afterPlaybackPromptOkTarget,
      entry,
      parentMenu,
      rootEntries,
      directReturnTarget,
    )
    : null;
  const promptHomeTarget = hasPrompt && entry?.afterPlaybackPromptHomeTarget
    ? resolveGeneratedTargetForStory(
      entry.afterPlaybackPromptHomeTarget,
      entry,
      parentMenu,
      rootEntries,
      promptOkTarget,
    )
    : null;

  return {
    directReturn: {
      targetId: directReturnTarget,
      isModified: !!entry?.returnAfterPlay && directReturnTarget !== inheritedReturnTarget,
      isBypassedByEndNode: usesEndNode,
    },
    storyHome: {
      targetId: homeTarget,
      isConfigured: !!entry?.returnOnHome,
      isNone: !!entry?.returnOnHomeNone,
      isInactive: entry?.controlSettings?.home === false,
    },
    endNodeReturn: {
      // `targetId` (rétro-compatible) = cible explicitement configurée sur le nœud de fin.
      // `effectiveTargetId` = cible réellement générée pour cette histoire (gère le fallback Rust).
      targetId: endNodeConfiguredTargetId,
      effectiveTargetId: endNodeEffectiveTargetId,
      isConfigured: endNodeConfiguredTargetId !== null,
      isActive: usesEndNode || importedNightPrompt,
      isImportedPrompt: importedNightPrompt,
      isNightMode: !!project?.globalOptions?.nightMode,
    },
    promptHome: {
      targetId: promptHomeTarget,
      okTargetId: promptOkTarget,
      isConfigured: !!entry?.afterPlaybackPromptHomeTarget,
      isNone: !!entry?.afterPlaybackPromptHomeNone,
      isInactive: entry?.afterPlaybackPromptControlSettings?.home === false,
      isImportedNightPrompt: importedNightPrompt,
    },
    promptReturn: {
      targetId: promptOkTarget,
      isConfigured: !!entry?.afterPlaybackPromptOkTarget || importedNightPrompt,
      isInactive: entry?.afterPlaybackPromptControlSettings?.ok === false
        && entry?.afterPlaybackPromptControlSettings?.autoplay === false,
      isImportedNightPrompt: importedNightPrompt,
    },
    usesEndNode,
    hasPrompt,
    hasSequence,
    isCombinedNightStoryBypass: isCombinedNightStoryBypass(entry, project),
  };
}

export function getGeneratedEndNodeHomeNavigation(project) {
  if (!hasGeneratedEndNode(project)) return null;
  const homeTarget = normalizeNavigationTarget(project?.nightModeHomeReturn);
  if (!homeTarget) return null;
  const returnTarget = normalizeNavigationTarget(project?.nightModeReturn);
  if (homeTarget === returnTarget) return null;
  return {
    targetId: isNextStoryNavigationTarget(homeTarget)
      ? CONTEXTUAL_NEXT_STORY_TARGET
      : resolveNavigationTargetId(homeTarget, null),
    isNightMode: !!project?.globalOptions?.nightMode,
  };
}

export function getGeneratedEndNodeReturnNavigation(project) {
  if (!hasGeneratedEndNode(project)) return null;
  const returnTarget = normalizeNavigationTarget(project?.nightModeReturn);
  if (!returnTarget) {
    return {
      targetId: null,
      isExplicit: false,
      isContextual: true,
      isDefaultContextual: true,
    };
  }
  return {
    targetId: isNextStoryNavigationTarget(returnTarget)
      ? CONTEXTUAL_NEXT_STORY_TARGET
      : resolveNavigationTargetId(returnTarget, null),
    isExplicit: true,
    isContextual: isNextStoryNavigationTarget(returnTarget),
    isDefaultContextual: false,
  };
}
