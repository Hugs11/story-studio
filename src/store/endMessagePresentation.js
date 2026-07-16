import { pathKey } from '../utils/fileUtils.js';
import { END_HOME_NONE } from './endMessageHome.js';

// Classification de presentation du message de fin. Les donnees importees ne
// contiennent pas de marqueur de provenance : cette fonction decrit seulement
// le comportement effectif et garde les surfaces UI synchronisees.
const END_MESSAGE_GLOBAL = 'global';
const END_MESSAGE_LOCAL_PROMPT = 'local_prompt';
const END_MESSAGE_LOCAL_SEQUENCE = 'local_sequence';
const END_MESSAGE_NONE = 'none';

const PROMPT_CONTROL_DEFAULTS = {
  autoplay: true,
  ok: true,
  home: true,
  pause: false,
  wheel: false,
};

function sameTarget(left, right) {
  return (left ?? null) === (right ?? null);
}

function endHomesMatch(promptHome, globalHome) {
  if (promptHome?.kind !== globalHome?.kind) return false;
  if (promptHome?.kind === END_HOME_NONE) return true;
  return sameTarget(promptHome?.effectiveTargetId, globalHome?.effectiveTargetId);
}

function getPromptControlDifferences(controlSettings = {}) {
  return Object.keys(PROMPT_CONTROL_DEFAULTS).filter((key) => (
    (controlSettings?.[key] ?? PROMPT_CONTROL_DEFAULTS[key]) !== PROMPT_CONTROL_DEFAULTS[key]
  ));
}

export function getEffectiveEndMessageControlState(controls = {}, home = null) {
  const autoplay = controls.autoplay === true;
  const ok = controls.ok !== false;
  const homeEnabled = controls.home !== false;
  return {
    playback: autoplay ? 'autoplay' : (ok ? 'wait-ok' : 'stays'),
    home: homeEnabled ? (home?.kind === END_HOME_NONE ? 'pack-start' : 'target') : 'disabled',
  };
}

// Les cibles ont deja ete resolues par generatedNavigation : `next_story`, les
// fallbacks de derniere histoire et les trois etats Home y sont donc compares
// selon le meme contrat que Rust et le simulateur.
export function classifyEndMessagePresentation({
  entry,
  active = true,
  globalActive = false,
  globalAudio = null,
  promptOkTargetId = null,
  globalOkTargetId = null,
  promptHome = null,
  globalHome = null,
} = {}) {
  const hasSequence = (entry?.afterPlaybackSequence?.length ?? 0) > 0;
  const hasPrompt = !!entry?.afterPlaybackPromptAudio;
  const audioMatches = !!(
    hasPrompt
    && pathKey(entry?.afterPlaybackPromptAudio)
    && pathKey(entry?.afterPlaybackPromptAudio) === pathKey(globalAudio)
  );
  const okMatches = hasPrompt && sameTarget(promptOkTargetId, globalOkTargetId);
  const homeMatches = hasPrompt && endHomesMatch(promptHome, globalHome);
  const controlDifferences = getPromptControlDifferences(entry?.afterPlaybackPromptControlSettings);

  if (!active) {
    return {
      presentationKind: END_MESSAGE_NONE,
      audioMatches: false,
      okMatches: false,
      homeMatches: false,
      controlDifferences,
      effectiveOk: null,
      effectiveHome: null,
    };
  }

  let presentationKind = END_MESSAGE_NONE;
  if (hasSequence) presentationKind = END_MESSAGE_LOCAL_SEQUENCE;
  else if (hasPrompt && !globalActive) presentationKind = END_MESSAGE_LOCAL_PROMPT;
  else if (hasPrompt && audioMatches && okMatches && homeMatches) presentationKind = END_MESSAGE_GLOBAL;
  else if (hasPrompt) presentationKind = END_MESSAGE_LOCAL_PROMPT;
  else if (globalActive) presentationKind = END_MESSAGE_GLOBAL;

  return {
    presentationKind,
    audioMatches,
    okMatches,
    homeMatches,
    controlDifferences,
    effectiveOk: presentationKind === END_MESSAGE_GLOBAL ? globalOkTargetId : promptOkTargetId,
    effectiveHome: presentationKind === END_MESSAGE_GLOBAL ? globalHome : promptHome,
  };
}
