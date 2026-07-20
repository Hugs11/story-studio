import { basenameNoExt, pathKey } from '../utils/fileUtils.js';
import { getEffectiveEndBehavior } from './generatedNavigation.js';
import { refTargetEntryId } from './navigationTargets.js';
import { buildProjectIndex, findEntryById } from './projectModel/index.js';

const ENTRY_NAVIGATION_FIELDS = [
  'returnAfterPlay',
  'returnOnHome',
  'titleReturnOnHome',
  'afterPlaybackPromptOkTarget',
  'afterPlaybackPromptHomeTarget',
];

function trimAssemblyPartSuffix(value) {
  return String(value || '')
    .trim()
    .replace(/[\s._–—-]+(?:pt\.?|part(?:ie)?)\s*(?:n[°º]?\s*)?\d+\s*$/iu, '')
    .replace(/\s*[([]\s*\d+\s*[\])]\s*$/u, '')
    .replace(/[\s._–—-]+$/u, '')
    .trim();
}

function commonAssemblyPrefix(names) {
  if (names.length === 0) return '';
  const prefix = names.slice(1).reduce((current, name) => {
    let index = 0;
    while (
      index < current.length
      && index < name.length
      && current[index].toLocaleLowerCase() === name[index].toLocaleLowerCase()
    ) index += 1;
    return current.slice(0, index);
  }, names[0]);
  return prefix.replace(/[\s._–—-]+$/u, '').trim();
}

function stripAssemblyProjectPrefix(value, projectPrefix) {
  const prefix = String(projectPrefix || '').trim();
  if (!prefix) return value;
  const marker = `${prefix}__`;
  return value.toLocaleLowerCase().startsWith(marker.toLocaleLowerCase())
    ? value.slice(marker.length)
    : value;
}

export function getAudioAssemblyLogicalFileName({ items = [], storyNames = [], projectPrefix = '' } = {}) {
  const contextualNames = storyNames
    .map(trimAssemblyPartSuffix)
    .filter(Boolean);
  if (contextualNames.length > 0) {
    const firstKey = contextualNames[0].toLocaleLowerCase();
    const sharedName = contextualNames.every((name) => name.toLocaleLowerCase() === firstKey)
      ? contextualNames[0]
      : commonAssemblyPrefix(contextualNames);
    if (sharedName) return `${sharedName}.flac`;
    return `${contextualNames[0]}_assemble.flac`;
  }

  const mediaNames = items
    .map((item) => stripAssemblyProjectPrefix(
      basenameNoExt(item?.name || item?.path || 'audio'),
      projectPrefix,
    ))
    .filter(Boolean);
  const firstName = mediaNames[0] || 'audio';
  const commonPrefix = commonAssemblyPrefix(mediaNames);
  return `${commonPrefix || firstName}_assemble.flac`;
}

function normalizeEntryIds(entryIds) {
  return [...new Set([...(entryIds ?? [])].filter((id) => typeof id === 'string' && id))];
}

function getContainerEntries(project, parentId, projectIndex) {
  if (parentId == null) return project?.rootEntries ?? [];
  const parent = findEntryById(project, parentId, projectIndex);
  return parent?.type === 'menu' ? (parent.children ?? []) : [];
}

function isKnownMissing(path, statusByPath) {
  if (!path) return true;
  if (statusByPath?.[path] === false) return true;
  const wantedKey = pathKey(path);
  return Object.entries(statusByPath ?? {}).some(([candidate, exists]) => (
    exists === false && pathKey(candidate) === wantedKey
  ));
}

function sourceSignatureRows(project, entryIds) {
  const index = buildProjectIndex(project);
  const rows = [];
  for (const id of entryIds) {
    const entry = index.entryById.get(id);
    if (!entry) {
      rows.push([id, null]);
      continue;
    }
    const parentId = index.parentMenuById.get(id) ?? null;
    const siblings = getContainerEntries(project, parentId, index);
    rows.push([
      id,
      parentId,
      siblings.findIndex((candidate) => candidate.id === id),
      entry.type,
      pathKey(entry.audio ?? ''),
      entry,
    ]);
  }
  return rows;
}

export function createMediaToolSourceSignature(project, entryIds) {
  return JSON.stringify(sourceSignatureRows(project, normalizeEntryIds(entryIds)));
}

export function resolveAudioStoriesInProjectOrder(project, entryIds, statusByPath = {}) {
  const requestedIds = normalizeEntryIds(entryIds);
  if (requestedIds.length === 0) {
    return { valid: false, code: 'empty-selection', reason: 'Aucune histoire sélectionnée.', stories: [] };
  }

  const requested = new Set(requestedIds);
  const projectIndex = buildProjectIndex(project);
  const selectedEntries = projectIndex.flatEntries
    .filter(({ id }) => requested.has(id))
    .map(({ entry }) => entry);

  if (selectedEntries.length !== requestedIds.length || selectedEntries.some((entry) => entry.type !== 'story')) {
    return {
      valid: false,
      code: 'mixed-selection',
      reason: 'Sélectionnez uniquement des histoires.',
      stories: [],
    };
  }

  const withoutAudio = selectedEntries.find((entry) => !entry.audio);
  if (withoutAudio) {
    return {
      valid: false,
      code: 'missing-audio',
      reason: `L’histoire « ${withoutAudio.name || 'sans nom'} » ne possède pas d’audio principal.`,
      stories: [],
    };
  }

  const inaccessible = selectedEntries.find((entry) => isKnownMissing(entry.audio, statusByPath));
  if (inaccessible) {
    return {
      valid: false,
      code: 'inaccessible-audio',
      reason: `Le fichier audio de « ${inaccessible.name || 'sans nom'} » est introuvable.`,
      stories: [],
    };
  }

  return {
    valid: true,
    code: null,
    reason: '',
    stories: selectedEntries,
    entryIds: selectedEntries.map((entry) => entry.id),
    sourcePaths: selectedEntries.map((entry) => entry.audio),
    projectIndex,
  };
}

export function buildMediaAudioToolRequest({
  project,
  entryIds,
  statusByPath = {},
  origin,
  tool,
  requestId,
}) {
  const resolved = resolveAudioStoriesInProjectOrder(project, entryIds, statusByPath);
  if (!resolved.valid) return resolved;
  if (tool === 'split' && resolved.stories.length !== 1) {
    return { valid: false, code: 'split-count', reason: 'Sélectionnez une seule histoire à découper.' };
  }
  if (tool === 'assemble' && resolved.stories.length < 2) {
    return { valid: false, code: 'assemble-count', reason: 'Sélectionnez au moins deux histoires à assembler.' };
  }

  return {
    valid: true,
    request: {
      requestId,
      origin,
      tool,
      ...(tool === 'assemble' ? { mode: 'assemble' } : {}),
      entryIds: resolved.entryIds,
      sourcePaths: resolved.sourcePaths,
      sourceSignature: createMediaToolSourceSignature(project, resolved.entryIds),
      storyNames: resolved.stories.map((entry) => entry.name || 'sans nom'),
    },
  };
}

export function validateMediaAudioToolRequest(project, request, statusByPath = {}) {
  if (!request?.requestId || request.origin === 'media') {
    return { valid: false, code: 'missing-context', reason: 'Aucun contexte projet n’est associé à cette opération.' };
  }
  const resolved = resolveAudioStoriesInProjectOrder(project, request.entryIds, statusByPath);
  if (!resolved.valid) return resolved;
  if (resolved.sourcePaths.some((path, index) => pathKey(path) !== pathKey(request.sourcePaths?.[index]))) {
    return { valid: false, code: 'source-changed', reason: 'Une histoire ou son audio a changé pendant le traitement.' };
  }
  if (createMediaToolSourceSignature(project, request.entryIds) !== request.sourceSignature) {
    return { valid: false, code: 'source-changed', reason: 'Le projet a changé pendant le traitement.' };
  }
  return { valid: true, code: null, reason: '', stories: resolved.stories, projectIndex: resolved.projectIndex };
}

function navigationTargetsForEntry(entry) {
  const targets = ENTRY_NAVIGATION_FIELDS.map((field) => entry?.[field]);
  for (const step of entry?.afterPlaybackSequence ?? []) {
    targets.push(step?.okTarget, step?.homeTarget);
  }
  if (entry?.afterPlaybackHomeStep) {
    targets.push(entry.afterPlaybackHomeStep.okTarget, entry.afterPlaybackHomeStep.homeTarget);
  }
  if (entry?.type === 'ref') targets.push(entry.target);
  return targets.filter(Boolean);
}

function preservedAssemblyTargets(firstStory, lastStory) {
  const targets = [firstStory?.titleReturnOnHome];
  for (const field of [
    'returnAfterPlay',
    'returnOnHome',
    'afterPlaybackPromptOkTarget',
    'afterPlaybackPromptHomeTarget',
  ]) {
    targets.push(lastStory?.[field]);
  }
  for (const step of lastStory?.afterPlaybackSequence ?? []) {
    targets.push(step?.okTarget, step?.homeTarget);
  }
  if (lastStory?.afterPlaybackHomeStep) {
    targets.push(lastStory.afterPlaybackHomeStep.okTarget, lastStory.afterPlaybackHomeStep.homeTarget);
  }
  return targets.filter(Boolean);
}

function findExternalNavigationToEntries(project, targetIds, removedSourceIds = new Set()) {
  const targets = new Set(targetIds ?? []);
  if (targets.size === 0) return [];
  const usages = [];
  for (const [field, target] of [
    ['nightModeReturn', project?.nightModeReturn],
    ['nightModeHomeReturn', project?.nightModeHomeReturn],
  ]) {
    const targetId = refTargetEntryId(target);
    if (targetId && targets.has(targetId)) usages.push({ sourceId: 'root', field, targetId });
  }
  const index = buildProjectIndex(project);
  for (const { entry } of index.flatEntries) {
    if (removedSourceIds.has(entry.id)) continue;
    for (const target of navigationTargetsForEntry(entry)) {
      const targetId = refTargetEntryId(target);
      if (targetId && targets.has(targetId)) usages.push({ sourceId: entry.id, targetId });
    }
  }
  return usages;
}

export function getAssemblyReplacementEligibility(project, entryIds) {
  const resolved = resolveAudioStoriesInProjectOrder(project, entryIds);
  if (!resolved.valid) return resolved;
  if (resolved.stories.length < 2) {
    return { valid: false, code: 'assemble-count', reason: 'Au moins deux histoires sont nécessaires.' };
  }

  const parentIds = resolved.stories.map((story) => resolved.projectIndex.parentMenuById.get(story.id) ?? null);
  if (new Set(parentIds).size !== 1) {
    return { valid: false, code: 'multiple-parents', reason: 'Les histoires ne sont plus dans le même dossier.' };
  }
  const parentId = parentIds[0];
  const siblings = getContainerEntries(project, parentId, resolved.projectIndex);
  const positions = resolved.stories.map((story) => siblings.findIndex((entry) => entry.id === story.id));
  if (positions.some((position, index) => index > 0 && position !== positions[0] + index)) {
    return { valid: false, code: 'not-consecutive', reason: 'Les histoires ne sont plus consécutives dans l’arbre.' };
  }

  for (let index = 0; index < resolved.stories.length - 1; index += 1) {
    const story = resolved.stories[index];
    const nextStory = resolved.stories[index + 1];
    const parent = parentId == null ? null : resolved.projectIndex.entryById.get(parentId);
    const behavior = getEffectiveEndBehavior(story, parent, project, project?.rootEntries ?? []);
    const explicitRootMatchesRootDefault = parentId == null
      && story.returnAfterPlay === 'root'
      && behavior.finalTargetId === 'root';
    const hasAmbiguousReturn = !!story.returnAfterPlay
      && behavior.finalTargetId !== `story_play:${nextStory.id}`
      && !explicitRootMatchesRootDefault;
    const hasStoryHomeOverride = !!story.returnOnHome || !!story.returnOnHomeNone;
    if (behavior.usesEndStep || hasAmbiguousReturn || hasStoryHomeOverride) {
      return {
        valid: false,
        code: 'ambiguous-navigation',
        reason: 'La navigation entre les histoires n’est pas un enchaînement direct et sûr.',
      };
    }
  }

  const removedIds = new Set(resolved.entryIds.slice(1));
  const selectedIds = new Set(resolved.entryIds);
  const incoming = findExternalNavigationToEntries(project, removedIds, selectedIds);
  for (const target of preservedAssemblyTargets(resolved.stories[0], resolved.stories.at(-1))) {
    const targetId = refTargetEntryId(target);
    if (targetId && removedIds.has(targetId)) {
      incoming.push({ sourceId: resolved.stories[0].id, targetId });
    }
  }
  if (incoming.length > 0) {
    return {
      valid: false,
      code: 'incoming-navigation',
      reason: 'Une référence ou une navigation cible une histoire qui serait supprimée.',
      incoming,
    };
  }

  return { ...resolved, valid: true, parentId, positions };
}

export function getMediaToolAutomaticProjectAction({
  request,
  contextValidation,
  replacementEligibility,
}) {
  if (
    request?.origin !== 'media'
    && request?.tool === 'assemble'
    && contextValidation?.valid
    && replacementEligibility?.valid
  ) {
    return 'replace-stories-with-assembly';
  }
  return null;
}

export function haveSameMediaPathMultiset(leftPaths, rightPaths) {
  if (!Array.isArray(leftPaths) || !Array.isArray(rightPaths) || leftPaths.length !== rightPaths.length) {
    return false;
  }
  const remaining = new Map();
  for (const path of leftPaths) {
    const key = pathKey(path);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const path of rightPaths) {
    const key = pathKey(path);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return false;
    if (count === 1) remaining.delete(key);
    else remaining.set(key, count - 1);
  }
  return remaining.size === 0;
}
