import {
  NAV_TARGET_NEXT_STORY,
  decodeNavigationMenuId,
  decodeNavigationStoryId,
  encodeStoryNavigationTarget,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
  normalizeNavigationTarget,
} from './navigationTargets.js';

// Sémantique Home d'un message de fin (global ou prompt local), miroir du builder Rust.
// Trois états distincts que l'UI ne doit jamais confondre : `none` (absence de transition)
// n'est PAS `follow-ok` (fallback sur la destination OK).
export const END_HOME_NONE = 'none'; // aucune homeTransition → retour au début du pack (squareOne)
export const END_HOME_FOLLOW_OK = 'follow-ok'; // transition identique à la destination OK
export const END_HOME_TARGET = 'target'; // transition résolue vers une cible explicite/contextuelle

// Message de fin global (`nightModeHomeReturn`) — miroir de `compute_night_bridge_targets` :
//   vide          → `raw_home = None` → aucune homeTransition → `none`
//   cible définie → transition résolue                        → `target`
// Le global n'a pas de `follow-ok` : une valeur vide signifie explicitement « aucune transition ».
export function classifyGlobalEndHome(project) {
  return normalizeNavigationTarget(project?.nightModeHomeReturn)
    ? END_HOME_TARGET
    : END_HOME_NONE;
}

// Prompt de fin local (`afterPlaybackPrompt*`) — miroir de `story_branch.rs` :
//   `afterPlaybackPromptHomeNone`     → `None`                                     → `none`
//   sans `homeTarget`                 → `resolve_story_home_transition(None, ok)`  → `follow-ok`
//   `homeTarget` explicite/contextuel → transition résolue                        → `target`
export function classifyPromptHome(entry) {
  if (entry?.afterPlaybackPromptHomeNone) return END_HOME_NONE;
  if (normalizeNavigationTarget(entry?.afterPlaybackPromptHomeTarget)) return END_HOME_TARGET;
  return END_HOME_FOLLOW_OK;
}

// Assemble `{ kind, targetId }` à partir d'une classification et des cibles déjà résolues
// par l'appelant (résolution `next_story` contextuelle incluse). C'est la forme commune
// consommée par le miroir de navigation, le simulateur projet et le panneau central.
export function resolveEndHome(kind, { okTargetId = null, explicitTargetId = null } = {}) {
  if (kind === END_HOME_FOLLOW_OK) return { kind, targetId: okTargetId ?? null };
  if (kind === END_HOME_TARGET) return { kind, targetId: explicitTargetId ?? null };
  return { kind: END_HOME_NONE, targetId: null };
}

function findNextStoryTarget(entry, parentMenu, rootEntries) {
  if (!entry) return NAV_TARGET_NEXT_STORY;
  const siblings = parentMenu ? (parentMenu.children ?? []) : (rootEntries ?? []);
  const index = siblings.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return null;
  const next = siblings.slice(index + 1).find((candidate) => candidate.type === 'story');
  return next?.id ? encodeStoryNavigationTarget(next.id) : null;
}

// Résolution d'une cible Home miroir de `resolve_story_home_transition` Rust :
// - current_menu est un fallback du message, pas le parent ;
// - next_story devient l'approche de la sœur suivante, sinon le fallback du message ;
// - story_play:X revient à l'approche/titre X, jamais à sa lecture directe.
export function resolveEndHomeTarget(
  target,
  { entry = null, parentMenu = null, rootEntries = [], fallbackTargetId = null } = {},
) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return fallbackTargetId ?? null;
  if (isCurrentMenuNavigationTarget(normalized)) return fallbackTargetId ?? null;
  if (isNextStoryNavigationTarget(normalized)) {
    return findNextStoryTarget(entry, parentMenu, rootEntries) ?? fallbackTargetId ?? null;
  }
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isStoryPlayNavigationTarget(normalized)) {
    return encodeStoryNavigationTarget(decodeNavigationStoryId(normalized));
  }
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

export function resolvePromptEndHome(
  entry,
  { parentMenu = null, rootEntries = [], okTargetId = null } = {},
) {
  const kind = classifyPromptHome(entry);
  if (kind === END_HOME_NONE) {
    return { kind, targetId: null, effectiveTargetId: null };
  }
  if (kind === END_HOME_FOLLOW_OK) {
    return { kind, targetId: null, effectiveTargetId: okTargetId ?? null };
  }
  const targetId = resolveEndHomeTarget(entry?.afterPlaybackPromptHomeTarget, {
    entry,
    parentMenu,
    rootEntries,
    fallbackTargetId: okTargetId,
  });
  return { kind, targetId, effectiveTargetId: targetId };
}

export function resolveGlobalEndHome(
  project,
  { entry = null, parentMenu = null, rootEntries = [], okTargetId = null } = {},
) {
  const kind = classifyGlobalEndHome(project);
  if (kind === END_HOME_NONE) {
    return { kind, targetId: null, effectiveTargetId: null };
  }
  const targetId = resolveEndHomeTarget(project?.nightModeHomeReturn, {
    entry,
    parentMenu,
    rootEntries,
    fallbackTargetId: okTargetId,
  });
  return { kind, targetId, effectiveTargetId: targetId };
}
