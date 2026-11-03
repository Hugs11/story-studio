import { normalizeStoryEntry } from './schema.js';
import { getAssemblyReplacementEligibility, validateMediaAudioToolRequest } from '../mediaToolContext.js';
import { mediaRefusal } from '../../i18n/mediaPresentation.js';

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

// La raison reste un descripteur ; son texte est résolu à la lecture.
function failure(project, code, reasonRef, details = {}) {
  const { reason: _reason, reasonRef: _reasonRef, ...rest } = details;
  return mediaRefusal({ ok: false, project, code, ...rest }, reasonRef.key, reasonRef.params);
}

function terminalFieldsFrom(story) {
  return Object.fromEntries(TERMINAL_FIELDS.map((field) => [field, story?.[field]]));
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

export function replaceStoriesWithAssembledStory(project, {
  request,
  entryIds,
  outputPath,
  logicalName,
}) {
  const ids = entryIds ?? request?.entryIds ?? [];
  if (request) {
    const validation = validateMediaAudioToolRequest(project, request);
    if (!validation.valid) return failure(project, validation.code, validation.reasonRef);
  }
  if (!outputPath) return failure(project, 'missing-output', { key: 'media:tool.refusal.missingOutput' });
  const eligibility = getAssemblyReplacementEligibility(project, ids);
  if (!eligibility.valid) return failure(project, eligibility.code, eligibility.reasonRef, eligibility);

  const first = eligibility.stories[0];
  const last = eligibility.stories.at(-1);
  const replacement = normalizeStoryEntry({
    ...first,
    ...terminalFieldsFrom(last),
    id: first.id,
    name: String(logicalName || '').trim() || first.name,
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
