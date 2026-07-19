import { makeId, normalizeStoryEntry } from './schema.js';
import { findEntryById } from './index.js';
import { getAssemblyReplacementEligibility, validateMediaAudioToolRequest } from '../mediaToolContext.js';

const TERMINAL_FIELDS = [
  'controlSettings',
  'returnAfterPlay',
  'returnOnHome',
  'returnOnHomeNone',
  'afterPlaybackPromptAudio',
  'afterPlaybackPromptControlSettings',
  'afterPlaybackPromptOkTarget',
  'afterPlaybackPromptHomeTarget',
  'afterPlaybackPromptHomeNone',
  'afterPlaybackSequence',
  'afterPlaybackHomeStep',
];

function failure(project, code, reason, details = {}) {
  return { ok: false, project, code, reason, ...details };
}

function terminalFieldsFrom(story) {
  return Object.fromEntries(TERMINAL_FIELDS.map((field) => [field, story?.[field]]));
}

function withoutTerminalBehavior(story, nextStoryId) {
  return {
    ...story,
    returnAfterPlay: `story_play:${nextStoryId}`,
    returnOnHome: null,
    returnOnHomeNone: false,
    afterPlaybackPromptAudio: null,
    afterPlaybackPromptOkTarget: null,
    afterPlaybackPromptHomeTarget: null,
    afterPlaybackPromptHomeNone: false,
    afterPlaybackSequence: [],
    afterPlaybackHomeStep: null,
  };
}

function replaceSingleEntry(entries, entryId, replacements) {
  const next = [];
  for (const entry of entries ?? []) {
    if (entry.id === entryId) {
      next.push(...replacements);
    } else if (entry.type === 'menu') {
      next.push({ ...entry, children: replaceSingleEntry(entry.children ?? [], entryId, replacements) });
    } else {
      next.push(entry);
    }
  }
  return next;
}

function replaceSelectedSiblings(entries, retainedId, removedIds, replacement) {
  const next = [];
  for (const entry of entries ?? []) {
    if (entry.id === retainedId) {
      next.push(replacement);
    } else if (removedIds.has(entry.id)) {
      continue;
    } else if (entry.type === 'menu') {
      next.push({
        ...entry,
        children: replaceSelectedSiblings(entry.children ?? [], retainedId, removedIds, replacement),
      });
    } else {
      next.push(entry);
    }
  }
  return next;
}

export function replaceStoryWithAudioParts(project, { request, storyId, createdPaths }) {
  const targetId = storyId ?? request?.entryIds?.[0];
  const paths = (createdPaths ?? []).filter(Boolean);
  if (request) {
    const validation = validateMediaAudioToolRequest(project, request);
    if (!validation.valid) return failure(project, validation.code, validation.reason);
  }
  const story = findEntryById(project, targetId);
  if (!story || story.type !== 'story') return failure(project, 'story-missing', 'L’histoire d’origine est introuvable.');
  if (paths.length < 2) return failure(project, 'not-enough-parts', 'Au moins deux parties sont nécessaires.');

  const ids = [story.id, ...paths.slice(1).map(() => makeId())];
  const parts = paths.map((audio, index) => {
    const isLast = index === paths.length - 1;
    const base = {
      ...story,
      id: ids[index],
      audio,
      name: index === 0 ? story.name : `${story.name || 'Histoire'} — Partie ${index + 1}`,
      ...(index === 0 ? {} : { nativeStageId: null, nativeReference: false }),
    };
    return normalizeStoryEntry(isLast ? base : withoutTerminalBehavior(base, ids[index + 1]));
  });

  return {
    ok: true,
    project: { ...project, rootEntries: replaceSingleEntry(project.rootEntries ?? [], story.id, parts) },
    retainedId: story.id,
    createdIds: ids,
  };
}

export function replaceStoriesWithAssembledStory(project, { request, entryIds, outputPath }) {
  const ids = entryIds ?? request?.entryIds ?? [];
  if (request) {
    const validation = validateMediaAudioToolRequest(project, request);
    if (!validation.valid) return failure(project, validation.code, validation.reason);
  }
  if (!outputPath) return failure(project, 'missing-output', 'Le fichier assemblé est introuvable.');
  const eligibility = getAssemblyReplacementEligibility(project, ids);
  if (!eligibility.valid) return failure(project, eligibility.code, eligibility.reason, eligibility);

  const first = eligibility.stories[0];
  const last = eligibility.stories.at(-1);
  const replacement = normalizeStoryEntry({
    ...first,
    ...terminalFieldsFrom(last),
    id: first.id,
    audio: outputPath,
  });
  const removedIds = new Set(eligibility.entryIds.slice(1));
  return {
    ok: true,
    project: {
      ...project,
      rootEntries: replaceSelectedSiblings(project.rootEntries ?? [], first.id, removedIds, replacement),
    },
    retainedId: first.id,
    removedIds: [...removedIds],
  };
}
