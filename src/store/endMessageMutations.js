import { collectEndMessagePresentations } from './generatedNavigation.js';

function patchStory(entries, storyId, fields) {
  return (entries ?? []).map((entry) => {
    if (entry.id === storyId && entry.type === 'story') {
      const resolvedFields = typeof fields === 'function' ? fields(entry) : fields;
      return { ...entry, ...resolvedFields };
    }
    if (entry.type !== 'menu') return entry;
    return { ...entry, children: patchStory(entry.children, storyId, fields) };
  });
}

function findStory(entries, storyId) {
  for (const entry of entries ?? []) {
    if (entry.id === storyId && entry.type === 'story') return entry;
    if (entry.type === 'menu') {
      const found = findStory(entry.children, storyId);
      if (found) return found;
    }
  }
  return null;
}

function clearStoryEndPrompt() {
  return {
    afterPlaybackPromptAudio: null,
    afterPlaybackPromptOkTarget: null,
    afterPlaybackPromptHomeTarget: null,
    afterPlaybackPromptHomeNone: false,
    afterPlaybackSequence: [],
    afterPlaybackHomeStep: null,
  };
}

function globalPromptFields(fields = {}) {
  const next = {};
  if (Object.hasOwn(fields, 'nightModeAudio')) next.afterPlaybackPromptAudio = fields.nightModeAudio;
  if (Object.hasOwn(fields, 'nightModeReturn')) next.afterPlaybackPromptOkTarget = fields.nightModeReturn ?? null;
  if (Object.hasOwn(fields, 'nightModeHomeReturn')) {
    next.afterPlaybackPromptHomeNone = !fields.nightModeHomeReturn;
    next.afterPlaybackPromptHomeTarget = fields.nightModeHomeReturn ?? null;
  }
  return next;
}

export function updateGlobalEndMessageProject(project, fields) {
  const linkedStoryIds = collectEndMessagePresentations(project)
    .filter((item) => item.presentationKind === 'global' && item.entry.afterPlaybackPromptAudio)
    .map((item) => item.entry.id);
  let next = { ...project, ...(fields ?? {}) };
  const promptFields = globalPromptFields(fields);
  for (const storyId of linkedStoryIds) {
    next = { ...next, rootEntries: patchStory(next.rootEntries, storyId, promptFields) };
  }
  return next;
}

export function updateGlobalEndPlaybackProject(project, autoplay) {
  const normalizedAutoplay = !!autoplay;
  const linkedStoryIds = collectEndMessagePresentations(project)
    .filter((item) => item.presentationKind === 'global' && item.entry.afterPlaybackPromptAudio)
    .map((item) => item.entry.id);
  let next = {
    ...project,
    globalOptions: {
      ...project.globalOptions,
      endMessageAutoplay: normalizedAutoplay,
    },
  };
  for (const storyId of linkedStoryIds) {
    next = {
      ...next,
      rootEntries: patchStory(next.rootEntries, storyId, (story) => ({
        afterPlaybackPromptControlSettings: {
          ...(story.afterPlaybackPromptControlSettings ?? {}),
          autoplay: normalizedAutoplay,
          ok: true,
        },
      })),
    };
  }
  return next;
}

export function attachStoryEndToGlobalProject(project, storyId) {
  if (!project?.nightModeAudio || !findStory(project.rootEntries, storyId)) return project;
  return {
    ...project,
    rootEntries: patchStory(project.rootEntries, storyId, {
      afterPlaybackPromptAudio: project.nightModeAudio,
      afterPlaybackPromptOkTarget: project.nightModeReturn ?? null,
      afterPlaybackPromptHomeTarget: project.nightModeHomeReturn ?? null,
      afterPlaybackPromptHomeNone: !project.nightModeHomeReturn,
      afterPlaybackSequence: [],
      afterPlaybackHomeStep: null,
    }),
  };
}

export function removeGlobalEndMessageProject(project) {
  const linkedStoryIds = collectEndMessagePresentations(project)
    .filter((item) => item.presentationKind === 'global' && item.entry.afterPlaybackPromptAudio)
    .map((item) => item.entry.id);
  let next = {
    ...project,
    nightModeAudio: null,
    nightModeReturn: null,
    nightModeHomeReturn: null,
    globalOptions: { ...project.globalOptions, nightMode: false, endNode: false },
  };
  for (const storyId of linkedStoryIds) {
    next = { ...next, rootEntries: patchStory(next.rootEntries, storyId, clearStoryEndPrompt()) };
  }
  return next;
}
