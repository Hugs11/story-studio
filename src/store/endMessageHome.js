import { normalizeNavigationTarget } from './navigationTargets.js';

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
