import { getGeneratedStoryNavigation } from './generatedNavigation.js';

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

export function getLocalEndDraftApplicability({
  draft,
  entry,
  parentMenu = null,
  project,
} = {}) {
  const fields = buildLocalEndDraftFields(
    draft,
    draft?.audioSource ?? draft?.audio ?? null,
  );
  const navigation = getGeneratedStoryNavigation(
    { ...entry, ...fields },
    parentMenu,
    project,
    project?.rootEntries ?? [],
  );
  const presentationKind = navigation.endMessage.presentationKind;

  return {
    applicable: presentationKind === 'local_prompt',
    presentationKind,
    fields,
  };
}

export async function materializeLocalEndDraftFields({
  draft,
  entry,
  parentMenu = null,
  project,
  importFile,
} = {}) {
  const applicability = getLocalEndDraftApplicability({
    draft,
    entry,
    parentMenu,
    project,
  });
  if (!applicability.applicable) return null;

  const audio = draft?.audioSource
    ? (await importFile?.(draft.audioSource) ?? draft.audioSource)
    : draft?.audio ?? null;
  return buildLocalEndDraftFields(draft, audio);
}
