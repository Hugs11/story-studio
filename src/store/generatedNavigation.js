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
import { getGeneratedEndMessageControls, getGeneratedStoryPlayControls } from './generatedPlayback.js';
import { classifyGlobalEndHome, resolveGlobalEndHome, resolvePromptEndHome, END_HOME_NONE } from './endMessageHome.js';
import { classifyEndMessagePresentation } from './endMessagePresentation.js';

export const CONTEXTUAL_NEXT_STORY_TARGET = '__contextual_next_story__';

export function hasVisibleEndNode(project) {
  return !!(
    !project?.globalOptions?.autoNext
    && (
      project?.nightModeAudio
      || project?.globalOptions?.nightMode
      || project?.globalOptions?.endNode
    )
  );
}

export function hasGeneratedEndNode(project) {
  return !!(!project?.globalOptions?.autoNext && project?.nightModeAudio);
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

function resolveNavigationTargetId(target, parentMenu = null) {
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

function getAutoNextFallbackTarget(entry, parentMenu, project) {
  if (!project?.globalOptions?.autoNext) return null;
  if (entry?.type !== 'story') return null;
  const next = findNextStorySibling(entry, parentMenu, project?.rootEntries ?? []);
  if (next) return `story_play:${next.id}`;
  return parentMenu?.id ?? 'root';
}

function getAutoNextResolution(entry, parentMenu, project, rootEntries = []) {
  const enabled = !!project?.globalOptions?.autoNext;
  const applies = !!(enabled && entry?.type === 'story');
  const nextStory = applies ? findNextStorySibling(entry, parentMenu, rootEntries) : null;
  return {
    enabled,
    applies,
    targetId: applies
      ? (nextStory ? `story_play:${nextStory.id}` : (parentMenu?.id ?? 'root'))
      : null,
    hasNextStory: !!nextStory,
    isLastStory: applies && !nextStory,
    parentTargetId: parentMenu?.id ?? 'root',
  };
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

function isImportedNightPrompt(entry, parentMenu, project, rootEntries) {
  if (project?.globalOptions?.autoNext) return false;
  if (!project?.nightModeAudio || entry?.type !== 'story') return false;
  if (!entry?.afterPlaybackPromptAudio || (entry?.afterPlaybackSequence?.length ?? 0) > 0) return false;
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
  const promptHome = resolvePromptEndHome(entry, {
    parentMenu,
    rootEntries,
    okTargetId: promptTarget,
  });
  const globalHome = resolveGlobalEndHome(project, {
    entry,
    parentMenu,
    rootEntries,
    okTargetId: nightTarget,
  });
  return classifyEndMessagePresentation({
    entry,
    globalActive: true,
    globalAudio: project.nightModeAudio,
    promptOkTargetId: promptTarget,
    globalOkTargetId: nightTarget,
    promptHome,
    globalHome,
  }).presentationKind === 'global';
}

export function getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries) {
  const autoNextEnabled = !!project?.globalOptions?.autoNext;
  const hasPrompt = !!entry?.afterPlaybackPromptAudio && !autoNextEnabled;
  const hasSequence = (entry?.afterPlaybackSequence?.length ?? 0) > 0 && !autoNextEnabled;
  const autoNextFallback = getAutoNextFallbackTarget(entry, parentMenu, project);
  const fallbackReturnTarget = autoNextFallback ?? getStoryFallbackReturnTarget(entry, parentMenu, rootEntries);
  const directReturnTarget = resolveGeneratedTargetForStory(
    autoNextFallback ? null : entry?.returnAfterPlay,
    entry,
    parentMenu,
    rootEntries,
    fallbackReturnTarget,
  );
  const inheritedReturnTarget = getInheritedReturnTarget(entry, parentMenu, rootEntries);
  const usesEndNode = !!(
    project?.nightModeAudio
    && !autoNextEnabled
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
  const promptOkTarget = hasPrompt
    ? resolveGeneratedTargetForStory(
      entry.afterPlaybackPromptOkTarget,
      entry,
      parentMenu,
      rootEntries,
      directReturnTarget,
    )
    : null;
  const promptHomeResolved = hasPrompt
    ? resolvePromptEndHome(entry, { parentMenu, rootEntries, okTargetId: promptOkTarget })
    : { kind: null, targetId: null, effectiveTargetId: null };
  const globalHomeResolved = (usesEndNode || importedNightPrompt)
    ? resolveGlobalEndHome(project, {
      entry,
      parentMenu,
      rootEntries,
      okTargetId: endNodeEffectiveTargetId,
    })
    : { kind: null, targetId: null, effectiveTargetId: null };
  const endMessageBase = classifyEndMessagePresentation({
    entry,
    active: !autoNextEnabled,
    globalActive: usesEndNode || importedNightPrompt,
    globalAudio: project?.nightModeAudio,
    promptOkTargetId: promptOkTarget,
    globalOkTargetId: endNodeEffectiveTargetId,
    promptHome: promptHomeResolved,
    globalHome: globalHomeResolved,
  });
  const endMessage = {
    ...endMessageBase,
    controls: getGeneratedEndMessageControls(entry, {
      usePromptControls: hasPrompt && endMessageBase.presentationKind !== 'none',
    }),
  };
  const sequence = entry?.afterPlaybackSequence ?? [];
  const sequenceReturnTarget = hasSequence
    ? resolveGeneratedTargetForStory(
      sequence.at(-1)?.okTarget,
      entry,
      parentMenu,
      rootEntries,
      directReturnTarget,
    )
    : null;
  const endEffectiveTargetId = autoNextFallback
    ?? (endNodeEffectiveTargetId ?? sequenceReturnTarget ?? promptOkTarget ?? directReturnTarget);
  const homeTarget = entry?.returnOnHome
    ? resolveGeneratedTargetForStory(entry.returnOnHome, entry, parentMenu, rootEntries, directReturnTarget)
    : null;
  const implicitHomeTarget = !!entry?.returnOnHomeNone && entry?.controlSettings?.home !== false
    ? endEffectiveTargetId
    : null;

  return {
    directReturn: {
      targetId: directReturnTarget,
      isModified: !autoNextFallback && !!entry?.returnAfterPlay && directReturnTarget !== inheritedReturnTarget,
      isBypassedByEndNode: usesEndNode,
    },
    storyHome: {
      targetId: homeTarget,
      effectiveTargetId: homeTarget ?? implicitHomeTarget,
      isConfigured: !!entry?.returnOnHome,
      isNone: !!entry?.returnOnHomeNone && entry?.controlSettings?.home === false,
      isInactive: entry?.controlSettings?.home === false,
      isImplicit: !!entry?.returnOnHomeNone && entry?.controlSettings?.home !== false,
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
      // `kind` (none | follow-ok | target) : sémantique canonique des 3 états Home.
      // `targetId` (rétro-compat) = cible explicite seule.
      // `effectiveTargetId` = cible réellement générée (none → null, follow-ok → OK).
      kind: promptHomeResolved.kind,
      targetId: promptHomeResolved.targetId,
      effectiveTargetId: promptHomeResolved.effectiveTargetId,
      okTargetId: promptOkTarget,
      isConfigured: !!entry?.afterPlaybackPromptHomeTarget,
      isNone: !!entry?.afterPlaybackPromptHomeNone,
      isInactive: entry?.afterPlaybackPromptControlSettings?.home === false,
      isImportedNightPrompt: importedNightPrompt,
    },
    endMessage,
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

export function getEffectiveEndBehavior(entry, parentMenu, project, rootEntries = []) {
  const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries);
  const autoNext = getAutoNextResolution(entry, parentMenu, project, rootEntries);
  const sequence = entry?.afterPlaybackSequence ?? [];
  let endStepKind = null;
  let finalTargetId = navigation.directReturn.targetId;

  if (autoNext.applies) {
    finalTargetId = autoNext.targetId;
  } else if (navigation.endNodeReturn.isActive) {
    endStepKind = navigation.endNodeReturn.isNightMode ? 'night-end-node' : 'end-node';
    finalTargetId = navigation.endNodeReturn.effectiveTargetId ?? navigation.directReturn.targetId;
  } else if (navigation.hasSequence) {
    const lastStep = sequence[sequence.length - 1];
    endStepKind = 'sequence';
    finalTargetId = resolveGeneratedTargetForStory(
      lastStep?.okTarget,
      entry,
      parentMenu,
      rootEntries,
      navigation.directReturn.targetId,
    );
  } else if (navigation.hasPrompt) {
    endStepKind = navigation.promptReturn.isImportedNightPrompt
      ? 'imported-night-prompt'
      : 'prompt';
    finalTargetId = navigation.promptReturn.targetId ?? navigation.directReturn.targetId;
  }

  const generatedPlayControls = getGeneratedStoryPlayControls(entry, parentMenu, project);
  const autoContinuation = !!(
    autoNext.applies
    ||
    endStepKind
    || entry?.returnAfterPlay
    || generatedPlayControls.autoplay
  );

  return {
    navigation,
    autoNext,
    generatedPlayControls,
    endStepKind,
    usesEndStep: !!endStepKind,
    directTargetId: navigation.directReturn.targetId,
    finalTargetId: autoContinuation ? finalTargetId : null,
    autoContinuation,
  };
}

export function summarizeEffectiveStoryEnds(
  entries,
  resolveParentMenu,
  project,
  rootEntries = [],
) {
  const behaviors = (entries ?? []).map((entry) => getEffectiveEndBehavior(
    entry,
    resolveParentMenu?.(entry) ?? null,
    project,
    rootEntries,
  ));
  const continuationModes = new Set(behaviors.map((behavior) => behavior.autoContinuation));
  const isMixed = continuationModes.size > 1;
  const autoContinuation = behaviors.length > 0 && !isMixed && behaviors[0].autoContinuation;
  const finalTargetIds = autoContinuation
    ? behaviors.map((behavior) => behavior.finalTargetId)
    : [];
  const uniqueFinalTargetIds = new Set(finalTargetIds);

  return {
    isMixed,
    autoContinuation,
    showDestination: isMixed || autoContinuation,
    commonFinalTargetId: autoContinuation && uniqueFinalTargetIds.size === 1
      ? finalTargetIds[0]
      : null,
    hasDifferentDestinations: autoContinuation && uniqueFinalTargetIds.size > 1,
  };
}

// Adaptateur de la classification partagee pour les ecrans agreges (editeur
// global, listes et operations atomiques). Chaque ligne conserve son parent,
// indispensable aux retours `next_story` contextuels.
export function collectEndMessagePresentations(project) {
  const result = [];
  const visit = (entries, parentMenu = null) => {
    for (const entry of entries ?? []) {
      if (entry?.type === 'story') {
        const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, project?.rootEntries ?? []);
        result.push({ entry, parentMenu, navigation, ...navigation.endMessage });
      } else if (entry?.type === 'menu') {
        visit(entry.children ?? [], entry);
      }
    }
  };
  visit(project?.rootEntries ?? []);
  return result;
}

export function getGeneratedEndNodeHomeNavigation(project) {
  if (!hasGeneratedEndNode(project)) return null;
  // Home global vide = `none` (aucune transition, retour au début du pack) : pas de badge Home
  // distinct à afficher, et surtout jamais assimilable au retour OK.
  if (classifyGlobalEndHome(project) === END_HOME_NONE) return null;
  const homeTarget = normalizeNavigationTarget(project?.nightModeHomeReturn);
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
