export const TITLE_CONTROL_DEFAULTS = Object.freeze({
  autoplay: false,
  ok: true,
  home: true,
  pause: false,
  wheel: true,
});

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Les contrôles de titre importés préservent le comportement du stage, mais ne
// rendent jamais l'audio optionnel. Seule l'action dédiée de l'éditeur porte
// cette intention explicite.
export function isExplicitSilentStoryTitle(entry) {
  return !hasPath(entry?.itemAudio) && !!entry?.silentTitleStage;
}

export function isStorySelectionAudioRequired(entry) {
  return !hasPath(entry?.itemAudio) && !isExplicitSilentStoryTitle(entry);
}

export function createSilentStoryTitleSettings(currentSettings) {
  return { ...TITLE_CONTROL_DEFAULTS, ...currentSettings };
}

export function createSilentStoryTitleUpdate(currentSettings) {
  return {
    itemAudio: null,
    silentTitleStage: true,
    titleControlSettings: createSilentStoryTitleSettings(currentSettings),
  };
}

export function createStorySelectionAudioUpdate(itemAudio) {
  return {
    itemAudio: itemAudio || null,
    silentTitleStage: false,
  };
}
