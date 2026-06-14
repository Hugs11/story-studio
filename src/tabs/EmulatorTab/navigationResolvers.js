import {
  decodeNavigationMenuId,
  decodeNavigationStoryId,
  encodeStoryNavigationTarget,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
  normalizeNavigationTarget,
} from '../../store/navigationTargets.js';
import { getGeneratedStoryNavigation } from '../../store/generatedNavigation.js';

export function findEntryLocation(entries, targetId, menuPath = []) {
  for (let index = 0; index < (entries?.length ?? 0); index += 1) {
    const entry = entries[index];
    if (entry.id === targetId) return { entry, menuPath, entryIdx: index };
    if (entry.type === 'menu') {
      const nested = findEntryLocation(entry.children ?? [], targetId, [...menuPath, entry.id]);
      if (nested) return nested;
    }
  }
  return null;
}

export function getMenuBrowseState(entries, targetMenuId) {
  if (targetMenuId === 'root') {
    return {
      state: 'browse',
      menuPath: [],
      entryIdx: 0,
    };
  }
  const location = findEntryLocation(entries, targetMenuId);
  if (!location?.entry || location.entry.type !== 'menu') return null;
  // Navigate to the menu's card in its parent context (not inside it).
  // The menu's audio will play, then autoBlackImage/ok navigates inside.
  return {
    menuPath: location.menuPath,
    entryIdx: location.entryIdx,
  };
}

export function resolveStoryReturnTarget(entry, parentMenu, project = null) {
  if (project && entry?.type === 'story') {
    return getGeneratedStoryNavigation(entry, parentMenu, project, project.rootEntries ?? []).directReturn.targetId;
  }

  const directTarget = normalizeNavigationTarget(entry?.returnAfterPlay);
  if (directTarget) {
    if (isRootNavigationTarget(directTarget)) return 'root';
    if (isCurrentMenuNavigationTarget(directTarget)) return parentMenu?.id ?? null;
    if (isNextStoryNavigationTarget(directTarget)) return 'next_story';
    if (isStoryNavigationTarget(directTarget)) return directTarget;
    return decodeNavigationMenuId(directTarget);
  }

  const inheritedTarget = normalizeNavigationTarget(parentMenu?.returnAfterPlay);
  if (inheritedTarget) {
    if (isRootNavigationTarget(inheritedTarget)) return 'root';
    if (isCurrentMenuNavigationTarget(inheritedTarget)) return parentMenu?.id ?? null;
    if (isNextStoryNavigationTarget(inheritedTarget)) return 'next_story';
    if (isStoryNavigationTarget(inheritedTarget)) return inheritedTarget;
    return decodeNavigationMenuId(inheritedTarget);
  }

  if (project?.globalOptions?.autoNext) return 'next_story';
  return null;
}

export function resolveStoryHomeTarget(entry, parentMenu, project = null) {
  if (entry?.returnOnHomeNone) return null;
  if (project && entry?.type === 'story') {
    const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, project.rootEntries ?? []);
    if (navigation.storyHome.isNone) return null;
    if (navigation.storyHome.targetId) return normalizeHomeTarget(navigation.storyHome.targetId);
  }

  if (entry?.returnOnHome) {
    const normalized = normalizeNavigationTarget(entry.returnOnHome);
    if (normalized) {
      if (isRootNavigationTarget(normalized)) return 'root';
      if (isCurrentMenuNavigationTarget(normalized)) return parentMenu?.id ?? null;
      if (isNextStoryNavigationTarget(normalized)) return 'next_story';
      if (isStoryNavigationTarget(normalized)) return normalizeHomeTarget(normalized);
      return decodeNavigationMenuId(normalized);
    }
  }
  return resolveStoryReturnTarget(entry, parentMenu, project);
}

export function normalizeHomeTarget(target) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (!isStoryPlayNavigationTarget(normalized)) return normalized;
  const storyId = decodeNavigationStoryId(normalized);
  return encodeStoryNavigationTarget(storyId);
}

export function resolveSequenceTarget(target, parentMenu) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isCurrentMenuNavigationTarget(normalized)) return parentMenu?.id ?? null;
  if (isNextStoryNavigationTarget(normalized)) return 'next_story';
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

export function formatPlaybackTime(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '--:--';
  const rounded = Math.floor(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
