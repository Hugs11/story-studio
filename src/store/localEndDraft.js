// Etat temporaire du brouillon de fin locale : aucune fonction de ce module ne
// touche le projet. L'import du fichier choisi est volontairement differe a
// l'application explicite du brouillon.
export function createLocalEndDraft(project) {
  return {
    audio: project?.nightModeAudio ?? null,
    audioSource: null,
    okTarget: project?.nightModeReturn ?? null,
    homeTarget: project?.nightModeHomeReturn ?? null,
    homeNone: !project?.nightModeHomeReturn,
  };
}

export function selectLocalEndDraftAudio(draft, source) {
  return { ...draft, audio: source ?? null, audioSource: source ?? null };
}

export function buildLocalEndDraftFields(draft, audio) {
  return {
    afterPlaybackPromptAudio: audio,
    afterPlaybackPromptOkTarget: draft?.okTarget ?? null,
    afterPlaybackPromptHomeTarget: draft?.homeTarget ?? null,
    afterPlaybackPromptHomeNone: !!draft?.homeNone,
    afterPlaybackSequence: [],
    afterPlaybackHomeStep: null,
  };
}
