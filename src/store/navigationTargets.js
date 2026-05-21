const NAV_TARGET_ROOT = 'root';
const NAV_TARGET_CURRENT_MENU = 'current_menu';
export const NAV_TARGET_NEXT_STORY = 'next_story';
const NAV_TARGET_MENU_PREFIX = 'menu:';
const NAV_TARGET_STORY_PREFIX = 'story:';
const NAV_TARGET_STORY_PLAY_PREFIX = 'story_play:';
const NAV_TARGET_STORY_HOME_STEP_PREFIX = 'story_home_step:';

export function normalizeNavigationTarget(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  if (trimmed === NAV_TARGET_ROOT || trimmed === NAV_TARGET_CURRENT_MENU || trimmed === NAV_TARGET_NEXT_STORY) return trimmed;
  if (trimmed.startsWith(NAV_TARGET_MENU_PREFIX)) {
    const menuId = trimmed.slice(NAV_TARGET_MENU_PREFIX.length).trim();
    return menuId ? `${NAV_TARGET_MENU_PREFIX}${menuId}` : null;
  }
  if (trimmed.startsWith(NAV_TARGET_STORY_PREFIX)) {
    const storyId = trimmed.slice(NAV_TARGET_STORY_PREFIX.length).trim();
    return storyId ? `${NAV_TARGET_STORY_PREFIX}${storyId}` : null;
  }
  if (trimmed.startsWith(NAV_TARGET_STORY_PLAY_PREFIX)) {
    const storyId = trimmed.slice(NAV_TARGET_STORY_PLAY_PREFIX.length).trim();
    return storyId ? `${NAV_TARGET_STORY_PLAY_PREFIX}${storyId}` : null;
  }
  if (trimmed.startsWith(NAV_TARGET_STORY_HOME_STEP_PREFIX)) {
    const storyId = trimmed.slice(NAV_TARGET_STORY_HOME_STEP_PREFIX.length).trim();
    return storyId ? `${NAV_TARGET_STORY_HOME_STEP_PREFIX}${storyId}` : null;
  }
  return `${NAV_TARGET_MENU_PREFIX}${trimmed}`;
}

export function encodeMenuNavigationTarget(menuId) {
  const trimmed = typeof menuId === 'string' ? menuId.trim() : '';
  return trimmed ? `${NAV_TARGET_MENU_PREFIX}${trimmed}` : null;
}

export function encodeStoryNavigationTarget(storyId) {
  const trimmed = typeof storyId === 'string' ? storyId.trim() : '';
  return trimmed ? `${NAV_TARGET_STORY_PREFIX}${trimmed}` : null;
}

export function encodeStoryPlayNavigationTarget(storyId) {
  const trimmed = typeof storyId === 'string' ? storyId.trim() : '';
  return trimmed ? `${NAV_TARGET_STORY_PLAY_PREFIX}${trimmed}` : null;
}

export function encodeStoryHomeStepNavigationTarget(storyId) {
  const trimmed = typeof storyId === 'string' ? storyId.trim() : '';
  return trimmed ? `${NAV_TARGET_STORY_HOME_STEP_PREFIX}${trimmed}` : null;
}

export function decodeNavigationMenuId(target) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized || normalized === NAV_TARGET_ROOT || normalized === NAV_TARGET_CURRENT_MENU || normalized === NAV_TARGET_NEXT_STORY) return null;
  if (normalized.startsWith(NAV_TARGET_STORY_PREFIX) || normalized.startsWith(NAV_TARGET_STORY_PLAY_PREFIX) || normalized.startsWith(NAV_TARGET_STORY_HOME_STEP_PREFIX)) return null;
  return normalized.slice(NAV_TARGET_MENU_PREFIX.length);
}

export function decodeNavigationStoryId(target) {
  const normalized = normalizeNavigationTarget(target);
  if (normalized?.startsWith(NAV_TARGET_STORY_PREFIX)) {
    return normalized.slice(NAV_TARGET_STORY_PREFIX.length);
  }
  if (normalized?.startsWith(NAV_TARGET_STORY_PLAY_PREFIX)) {
    return normalized.slice(NAV_TARGET_STORY_PLAY_PREFIX.length);
  }
  if (normalized?.startsWith(NAV_TARGET_STORY_HOME_STEP_PREFIX)) {
    return normalized.slice(NAV_TARGET_STORY_HOME_STEP_PREFIX.length);
  }
  return null;
}

export function isRootNavigationTarget(target) {
  return normalizeNavigationTarget(target) === NAV_TARGET_ROOT;
}

export function isCurrentMenuNavigationTarget(target) {
  return normalizeNavigationTarget(target) === NAV_TARGET_CURRENT_MENU;
}

export function isStoryNavigationTarget(target) {
  const normalized = normalizeNavigationTarget(target);
  return normalized !== null
    && (normalized.startsWith(NAV_TARGET_STORY_PREFIX) || normalized.startsWith(NAV_TARGET_STORY_PLAY_PREFIX) || normalized.startsWith(NAV_TARGET_STORY_HOME_STEP_PREFIX));
}

export function isStoryPlayNavigationTarget(target) {
  const normalized = normalizeNavigationTarget(target);
  return normalized !== null && normalized.startsWith(NAV_TARGET_STORY_PLAY_PREFIX);
}

export function isStoryHomeStepNavigationTarget(target) {
  const normalized = normalizeNavigationTarget(target);
  return normalized !== null && normalized.startsWith(NAV_TARGET_STORY_HOME_STEP_PREFIX);
}

export function isNextStoryNavigationTarget(target) {
  return normalizeNavigationTarget(target) === NAV_TARGET_NEXT_STORY;
}
