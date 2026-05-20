import { normalizeNavigationTarget } from './navigationTargets.js';
import { getExportPackName, parseConventionName } from '../utils/packConvention.js';

export const PROJECT_SCHEMA_VERSION = 3;

export const DEFAULT_PACK_METADATA = Object.freeze({
  title: '',
  author: '',
  version: 1,
  minAge: '3',
  producer: '',
  bonus: '',
  description: '',
  namingMode: 'convention',
  legacyExportName: '',
  legacyName: '',
});

function makeId() {
  return crypto.randomUUID();
}

const SIMPLE_MENU_ID = 'simple-root-menu';

function normalizeLocalFilePath(value) {
  if (typeof value !== 'string') return value ?? null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z]+:\/\//i.test(trimmed) || trimmed.startsWith('blob:') || trimmed.startsWith('data:')) {
    return trimmed;
  }

  // Normalise les chemins locaux Windows pour éviter les formes mixtes
  // `C:\foo/bar\baz` que le plugin-fs résout mal.
  if (/^[a-z]:[\\/]/i.test(trimmed)) {
    const drive = trimmed.slice(0, 2);
    const rest = trimmed
      .slice(2)
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\');
    return `${drive}${rest}`;
  }

  if (trimmed.startsWith('\\\\')) {
    const rest = trimmed
      .slice(2)
      .replace(/\//g, '\\')
      .replace(/\\+/g, '\\');
    return `\\\\${rest}`;
  }

  return trimmed;
}

function mediaPathKey(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase()
    : '';
}

function isSameMediaPath(a, b) {
  const ak = mediaPathKey(a);
  return !!ak && ak === mediaPathKey(b);
}

function normalizeOptions(options) {
  return {
    convertFormat: options?.convertFormat ?? true,
    addSilence: options?.addSilence ?? true,
    autoNext: options?.autoNext ?? false,
    selectNext: options?.selectNext ?? false,
    nightMode: options?.nightMode ?? false,
    aiImageGen: options?.aiImageGen ?? false,
    endNode: options?.endNode ?? false,
  };
}

function inferEntryType(entry) {
  if (!entry || typeof entry !== 'object') return 'story';
  if (entry.type === 'menu' || Array.isArray(entry.children) || (!entry.type && Array.isArray(entry.items))) {
    return 'menu';
  }
  if (entry.type === 'zip' || entry.zipPath) return 'zip';
  return 'story';
}

function normalizeControlSettings(entry, defaults) {
  const cs = entry.controlSettings ?? {};
  return {
    autoplay: cs.autoplay ?? defaults.autoplay,
    wheel: cs.wheel ?? defaults.wheel,
    pause: cs.pause ?? defaults.pause,
    ok: cs.ok ?? defaults.ok,
    home: cs.home ?? defaults.home,
  };
}

function normalizeAudioProcessing(value, fields) {
  if (!value || typeof value !== 'object') return {};
  const result = {};
  for (const field of fields) {
    const processing = value[field];
    if (processing?.skipSilence === true) {
      result[field] = { skipSilence: true };
    }
  }
  return result;
}

function normalizeImportWarnings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((warning) => warning && typeof warning === 'object')
    .filter((warning) => !(warning.field === 'returnOnHome' && warning.targetStageName === 'Cloche retour'))
    .map((warning) => ({
      entryId: typeof warning.entryId === 'string' ? warning.entryId : null,
      entryName: typeof warning.entryName === 'string' ? warning.entryName : '',
      field: typeof warning.field === 'string' ? warning.field : '',
      targetStageId: typeof warning.targetStageId === 'string' ? warning.targetStageId : null,
      targetStageName: typeof warning.targetStageName === 'string' ? warning.targetStageName : '',
      message: typeof warning.message === 'string' ? warning.message : 'Transition importee non modelisee.',
      sourceRootId: typeof warning.sourceRootId === 'string' ? warning.sourceRootId : null,
      sourceName: typeof warning.sourceName === 'string' ? warning.sourceName : '',
  }));
}

function normalizeTreeColor(value) {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function normalizeImportedContinuation(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    sourceStoryId: typeof value.sourceStoryId === 'string' ? value.sourceStoryId : null,
    sourceStoryName: typeof value.sourceStoryName === 'string' ? value.sourceStoryName : '',
    sourceStepName: typeof value.sourceStepName === 'string' ? value.sourceStepName : '',
  };
}

function rewritePrefixedNavigationTarget(value, idMap) {
  const normalized = normalizeNavigationTarget(value);
  if (!normalized || idMap.size === 0) return normalized;
  for (const [prefix, targetPrefix] of [
    ['story_home_step:', 'story_home_step:'],
    ['story_play:', 'story_play:'],
    ['story:', 'story:'],
    ['menu:', 'menu:'],
  ]) {
    if (normalized.startsWith(prefix)) {
      const id = normalized.slice(prefix.length);
      return idMap.has(id) ? `${targetPrefix}${idMap.get(id)}` : normalized;
    }
  }
  return normalized;
}

function collectContinuationIdMap(entry, prefix, idMap) {
  if (!entry || typeof entry !== 'object') return;
  const id = typeof entry.id === 'string' ? entry.id : null;
  if (id && !id.startsWith(`${prefix}-`)) {
    idMap.set(id, `${prefix}-${id}`);
  }
  for (const child of entry.children ?? entry.items ?? []) {
    collectContinuationIdMap(child, prefix, idMap);
  }
}

function applyContinuationIdMap(entry, idMap) {
  if (!entry || typeof entry !== 'object') return entry;
  const next = { ...entry };
  if (typeof next.id === 'string' && idMap.has(next.id)) {
    next.id = idMap.get(next.id);
  }
  for (const field of ['returnAfterPlay', 'returnOnHome', 'titleReturnOnHome', 'afterPlaybackPromptOkTarget', 'afterPlaybackPromptHomeTarget']) {
    if (Object.prototype.hasOwnProperty.call(next, field)) {
      next[field] = rewritePrefixedNavigationTarget(next[field], idMap);
    }
  }
  if (Array.isArray(next.afterPlaybackSequence)) {
    next.afterPlaybackSequence = next.afterPlaybackSequence.map((step) => ({
      ...step,
      okTarget: rewritePrefixedNavigationTarget(step?.okTarget, idMap),
      okChoiceTargets: Array.isArray(step?.okChoiceTargets)
        ? step.okChoiceTargets.map((target) => rewritePrefixedNavigationTarget(target, idMap)).filter(Boolean)
        : [],
      homeTarget: rewritePrefixedNavigationTarget(step?.homeTarget, idMap),
    }));
  }
  if (next.afterPlaybackHomeStep && typeof next.afterPlaybackHomeStep === 'object') {
    next.afterPlaybackHomeStep = {
      ...next.afterPlaybackHomeStep,
      okTarget: rewritePrefixedNavigationTarget(next.afterPlaybackHomeStep.okTarget, idMap),
      okChoiceTargets: Array.isArray(next.afterPlaybackHomeStep.okChoiceTargets)
        ? next.afterPlaybackHomeStep.okChoiceTargets
            .map((target) => rewritePrefixedNavigationTarget(target, idMap))
            .filter(Boolean)
        : [],
      homeTarget: rewritePrefixedNavigationTarget(next.afterPlaybackHomeStep.homeTarget, idMap),
    };
  }
  if (Array.isArray(next.children)) {
    next.children = next.children.map((child) => applyContinuationIdMap(child, idMap));
  }
  if (Array.isArray(next.items)) {
    next.items = next.items.map((child) => applyContinuationIdMap(child, idMap));
  }
  return next;
}

function prefixImportedContinuationChildren(children, menuId) {
  if (!Array.isArray(children) || !menuId) return children ?? [];
  const idMap = new Map();
  for (const child of children) collectContinuationIdMap(child, menuId, idMap);
  if (idMap.size === 0) return children;
  return children.map((child) => applyContinuationIdMap(child, idMap));
}

function normalizeAfterPlaybackSequence(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((step) => step && typeof step === 'object')
    .map((step) => ({
      id: step.id || makeId(),
      name: step.name || '',
      audio: normalizeLocalFilePath(step.audio),
      image: normalizeLocalFilePath(step.image),
      controlSettings: normalizeControlSettings(
        { controlSettings: step.controlSettings },
        { autoplay: true, wheel: false, pause: false, ok: false, home: true },
      ),
      okTarget: normalizeNavigationTarget(step.okTarget),
      okChoiceTargets: Array.isArray(step.okChoiceTargets)
        ? step.okChoiceTargets.map(normalizeNavigationTarget).filter(Boolean)
        : [],
      homeTarget: normalizeNavigationTarget(step.homeTarget),
      homeFollowsOk: !!step.homeFollowsOk,
      homeNone: !!step.homeNone,
    }));
}

function normalizeAfterPlaybackStep(value) {
  return normalizeAfterPlaybackSequence(value ? [value] : [])[0] ?? null;
}

function normalizeStoryEntry(entry = {}) {
  return {
    id: entry.id || makeId(),
    type: 'story',
    name: entry.name || '',
    treeColor: normalizeTreeColor(entry.treeColor),
    nativeStageId: typeof entry.nativeStageId === 'string' ? entry.nativeStageId : null,
    nativeReference: !!entry.nativeReference,
    audio: normalizeLocalFilePath(entry.audio),
    itemAudio: normalizeLocalFilePath(entry.itemAudio),
    itemImage: normalizeLocalFilePath(entry.itemImage),
    afterPlaybackPromptAudio: normalizeLocalFilePath(entry.afterPlaybackPromptAudio),
    afterPlaybackPromptControlSettings: normalizeControlSettings(
      { controlSettings: entry.afterPlaybackPromptControlSettings },
      { autoplay: true, wheel: false, pause: false, ok: true, home: true },
    ),
    afterPlaybackPromptOkTarget: normalizeNavigationTarget(entry.afterPlaybackPromptOkTarget),
    afterPlaybackPromptHomeTarget: normalizeNavigationTarget(entry.afterPlaybackPromptHomeTarget),
    afterPlaybackPromptHomeNone: !!entry.afterPlaybackPromptHomeNone,
    afterPlaybackSequence: normalizeAfterPlaybackSequence(entry.afterPlaybackSequence),
    afterPlaybackHomeStep: normalizeAfterPlaybackStep(entry.afterPlaybackHomeStep),
    autoGenerateImage: !!entry.autoGenerateImage,
    individualOptions: entry.individualOptions ?? {},
    controlSettings: normalizeControlSettings(entry, {
      autoplay: false,
      wheel: false,
      pause: true,
      ok: false,
      home: true,
    }),
    returnAfterPlay: normalizeNavigationTarget(entry.returnAfterPlay),
    returnOnHome: normalizeNavigationTarget(entry.returnOnHome),
    returnOnHomeNone: !!entry.returnOnHomeNone,
    titleReturnOnHome: normalizeNavigationTarget(entry.titleReturnOnHome),
    titleReturnOnHomeNone: !!entry.titleReturnOnHomeNone,
    titleControlSettings: entry.titleControlSettings
      ? normalizeControlSettings(
          { controlSettings: entry.titleControlSettings },
          { autoplay: false, wheel: true, pause: false, ok: true, home: true },
        )
      : null,
    audioProcessing: normalizeAudioProcessing(entry.audioProcessing, ['audio', 'itemAudio', 'afterPlaybackPromptAudio']),
  };
}

function normalizeZipEntry(entry = {}) {
  return {
    id: entry.id || makeId(),
    type: 'zip',
    name: entry.name || '',
    treeColor: normalizeTreeColor(entry.treeColor),
    zipPath: normalizeLocalFilePath(entry.zipPath),
    coverImage: normalizeLocalFilePath(entry.coverImage),
    coverAudio: normalizeLocalFilePath(entry.coverAudio),
  };
}

function normalizeMenuEntry(entry = {}) {
  const id = entry.id || makeId();
  const importedContinuation = normalizeImportedContinuation(entry.importedContinuation ?? entry._importedContinuation);
  const rawChildren = Array.isArray(entry.children) ? entry.children : (entry.items ?? []);
  const children = importedContinuation ? prefixImportedContinuationChildren(rawChildren, id) : rawChildren;
  return {
    id,
    type: 'menu',
    name: entry.name ?? '',
    treeColor: normalizeTreeColor(entry.treeColor),
    nativeStageId: typeof entry.nativeStageId === 'string' ? entry.nativeStageId : null,
    nativeReference: !!entry.nativeReference,
    audio: normalizeLocalFilePath(entry.audio),
    image: normalizeLocalFilePath(entry.image),
    autoBlackImage: !!entry.autoBlackImage,
    autoGenerateImage: !!entry.autoGenerateImage,
    individualOptions: entry.individualOptions ?? {},
    controlSettings: normalizeControlSettings(entry, {
      autoplay: false,
      wheel: true,
      pause: false,
      ok: true,
      home: true,
    }),
    returnAfterPlay: normalizeNavigationTarget(entry.returnAfterPlay),
    returnOnHome: normalizeNavigationTarget(entry.returnOnHome),
    nativeGraph: entry.nativeGraph ?? null,
    importedContinuation,
    audioProcessing: normalizeAudioProcessing(entry.audioProcessing, ['audio']),
    children: children.map(normalizeEntry),
  };
}

function normalizeEntry(entry = {}) {
  switch (inferEntryType(entry)) {
    case 'menu':
      return normalizeMenuEntry(entry);
    case 'zip':
      return normalizeZipEntry(entry);
    default:
      return normalizeStoryEntry(entry);
  }
}

function legacyRootEntries(project) {
  const rootItems = Array.isArray(project?.rootItems) ? project.rootItems : [];
  const menus = Array.isArray(project?.menus) ? project.menus : [];

  if (project?.projectType === 'simple') {
    const story = menus?.[0]?.items?.[0];
    return story ? [normalizeEntry(story)] : [];
  }

  return [
    ...rootItems.map(normalizeEntry),
    ...menus.map(normalizeEntry),
  ];
}

function findFirstStory(entries) {
  for (const entry of entries) {
    if (entry.type === 'story') return entry;
    if (entry.type === 'menu') {
      const nested = findFirstStory(entry.children ?? []);
      if (nested) return nested;
    }
  }
  return null;
}

function toLegacyItem(entry) {
  if (entry.type === 'zip') {
    return {
      id: entry.id,
      type: 'zip',
      name: entry.name,
      zipPath: entry.zipPath ?? null,
      coverImage: entry.coverImage ?? null,
      coverAudio: entry.coverAudio ?? null,
    };
  }

  return {
    id: entry.id,
    type: 'story',
    name: entry.name,
    nativeStageId: entry.nativeStageId ?? null,
    nativeReference: !!entry.nativeReference,
    audio: entry.audio ?? null,
    itemAudio: entry.itemAudio ?? null,
    itemImage: entry.itemImage ?? null,
    afterPlaybackPromptAudio: entry.afterPlaybackPromptAudio ?? null,
    afterPlaybackPromptControlSettings: entry.afterPlaybackPromptControlSettings ?? null,
    afterPlaybackPromptOkTarget: entry.afterPlaybackPromptOkTarget ?? null,
    afterPlaybackPromptHomeTarget: entry.afterPlaybackPromptHomeTarget ?? null,
    afterPlaybackPromptHomeNone: !!entry.afterPlaybackPromptHomeNone,
    afterPlaybackSequence: normalizeAfterPlaybackSequence(entry.afterPlaybackSequence),
    afterPlaybackHomeStep: normalizeAfterPlaybackStep(entry.afterPlaybackHomeStep),
    audioProcessing: entry.audioProcessing ?? {},
    autoGenerateImage: !!entry.autoGenerateImage,
    individualOptions: entry.individualOptions ?? {},
    returnAfterPlay: entry.returnAfterPlay ?? null,
    returnOnHome: entry.returnOnHome ?? null,
    returnOnHomeNone: !!entry.returnOnHomeNone,
    titleReturnOnHome: entry.titleReturnOnHome ?? null,
    titleReturnOnHomeNone: !!entry.titleReturnOnHomeNone,
  };
}

function toLegacyMenu(menu) {
  return {
    id: menu.id,
    name: menu.name,
    nativeStageId: menu.nativeStageId ?? null,
    nativeReference: !!menu.nativeReference,
    audio: menu.audio ?? null,
    image: menu.image ?? null,
    autoBlackImage: !!menu.autoBlackImage,
    autoGenerateImage: !!menu.autoGenerateImage,
    audioProcessing: menu.audioProcessing ?? {},
    individualOptions: menu.individualOptions ?? {},
    returnOnHome: menu.returnOnHome ?? null,
    items: (menu.children ?? []).filter((child) => child.type !== 'menu').map(toLegacyItem),
  };
}

function buildLegacyProjection(projectType, entries) {
  if (projectType === 'simple') {
    const story = findFirstStory(entries);
    return {
      rootItems: [],
      menus: [{
        id: SIMPLE_MENU_ID,
        name: 'Mon histoire',
        audio: null,
        image: null,
        autoBlackImage: false,
        autoGenerateImage: false,
        individualOptions: {},
        items: story ? [toLegacyItem(story)] : [],
      }],
    };
  }

  return {
    rootItems: entries.filter((entry) => entry.type !== 'menu').map(toLegacyItem),
    menus: entries.filter((entry) => entry.type === 'menu').map(toLegacyMenu),
  };
}

function inferProjectType(project, rootEntries) {
  if (project?.projectType) return project.projectType;
  return rootEntries.length > 0 ? 'pack' : null;
}

function countPlayableEntries(entries) {
  let count = 0;
  for (const entry of entries ?? []) {
    if (entry?.type === 'menu') count += countPlayableEntries(entry.children ?? []);
    else if (entry?.type === 'story' || entry?.type === 'zip') count += 1;
  }
  return count;
}

function nativeGraphStageCount(graph) {
  return graph?.stageCount ?? graph?.document?.stageNodes?.length ?? 0;
}

function nativeGraphStageId(stage) {
  return stage?.uuid || stage?.id || '';
}

function nativeGraphStagePositionKey(stage) {
  const x = Number(stage?.position?.x ?? 0);
  const y = Number(stage?.position?.y ?? 0);
  return [Number.isFinite(y) ? y : 0, Number.isFinite(x) ? x : 0];
}

function nativeGraphStageKind(stage) {
  if (stage?.squareOne) return 'Depart';
  if (stage?.controlSettings?.wheel && !stage?.controlSettings?.autoplay) return 'Choix';
  if (stage?.controlSettings?.autoplay) return 'Lecture';
  return 'Stage';
}

function nativeGraphProjectionLabel(stage, index) {
  const name = typeof stage?.name === 'string' ? stage.name.trim() : '';
  if (name && name !== 'Stage title') return name;
  return `${nativeGraphStageKind(stage)} ${String(index + 1).padStart(2, '0')}`;
}

function buildNativeGraphFallbackEntries(graph) {
  const stages = Array.isArray(graph?.document?.stageNodes) ? graph.document.stageNodes : [];
  const ordered = stages
    .filter((stage) => !stage?.squareOne && nativeGraphStageId(stage))
    .map((stage) => ({ stage, key: nativeGraphStagePositionKey(stage) }))
    .sort((a, b) => (a.key[0] - b.key[0]) || (a.key[1] - b.key[1]))
    .map(({ stage }, index) => ({
      id: nativeGraphStageId(stage),
      type: 'story',
      name: nativeGraphProjectionLabel(stage, index),
      nativeStageId: nativeGraphStageId(stage),
      audio: normalizeLocalFilePath(stage.audio),
      itemAudio: normalizeLocalFilePath(stage.audio),
      itemImage: normalizeLocalFilePath(stage.image),
      controlSettings: normalizeControlSettings(
        { controlSettings: stage.controlSettings },
        { autoplay: !!stage.controlSettings?.autoplay, wheel: !!stage.controlSettings?.wheel, pause: false, ok: false, home: true },
      ),
    }));
  if (ordered.length === 0) return [];
  return [normalizeMenuEntry({
    id: 'native-graph-stage-map',
    name: 'Carte du graphe interactif',
    audio: null,
    image: null,
    autoBlackImage: true,
    children: ordered,
  })];
}

function normalizeNativeGraph(graph, rootEntries, importWarnings) {
  if (!graph || typeof graph !== 'object') return null;
  const stageCount = nativeGraphStageCount(graph);
  const explicitRoundTrip = graph.preserveForRoundTrip === true || graph.roundTripMode === true || typeof graph.projectionReason === 'string' || typeof graph.roundTripReason === 'string';
  const lossyImportWarnings = Array.isArray(importWarnings) && importWarnings.length > 0;
  const sparseExtractedTree = stageCount >= 10 && countPlayableEntries(rootEntries) <= 1;
  if (!explicitRoundTrip && !lossyImportWarnings && !sparseExtractedTree) return null;
  return {
    ...graph,
    preserveForRoundTrip: true,
    projectionStatus: graph.projectionStatus || 'lossy',
    projectionReason: graph.projectionReason || graph.roundTripReason || 'branching-graph',
  };
}

function buildProjectIndexEntries(entries, ancestors, level, index) {
  let playableCount = 0;

  for (const entry of entries ?? []) {
    const entryId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    const ancestorsPath = [...ancestors];
    const parentEntry = ancestorsPath[ancestorsPath.length - 1] ?? null;
    const parentMenu = parentEntry?.type === 'menu' ? parentEntry : null;
    const path = [...ancestorsPath, entry];

    index.flatEntries.push({
      id: entry.id,
      type: entry.type,
      level,
      entry,
    });

    if (entryId) {
      index.entryById.set(entryId, entry);
      index.pathById.set(entryId, path);
      index.parentById.set(entryId, parentEntry?.id ?? null);
      index.parentMenuById.set(entryId, parentMenu?.id ?? null);
      index.entryIdCounts.set(entryId, (index.entryIdCounts.get(entryId) ?? 0) + 1);
      if (entry.type === 'menu') {
        index.menuEntries.push(entry);
      }
      if (!index.firstSimpleStory && entry.type === 'story') {
        index.firstSimpleStory = entry;
      }
    }

    let entryPlayableCount = 0;
    if (entry.type === 'menu') {
      entryPlayableCount = buildProjectIndexEntries(entry.children ?? [], path, level + 1, index);
    } else if (entry.type === 'story' || entry.type === 'zip') {
      entryPlayableCount = 1;
    }

    if (entryId) {
      index.playableDescendantCountById.set(entryId, entryPlayableCount);
    }
    playableCount += entryPlayableCount;
  }

  return playableCount;
}

export function buildProjectIndex(project) {
  const index = {
    entryById: new Map(),
    pathById: new Map(),
    parentById: new Map(),
    parentMenuById: new Map(),
    entryIdCounts: new Map(),
    playableDescendantCountById: new Map(),
    flatEntries: [],
    menuEntries: [],
    firstSimpleStory: null,
    rootPlayableCount: 0,
  };

  index.rootPlayableCount = buildProjectIndexEntries(project?.rootEntries ?? [], [], 1, index);
  return index;
}

function normalizeBaseProject(project = {}) {
  const packMetadata = normalizePackMetadata(project.packMetadata ?? buildPackMetadataFromLegacy(project));
  const projectName = cleanProjectName(project.projectName || project.name, '');
  let rootEntries = Array.isArray(project.rootEntries)
    ? project.rootEntries.map(normalizeEntry)
    : legacyRootEntries(project);
  const projectType = inferProjectType(project, rootEntries);
  const importWarnings = normalizeImportWarnings(project.importWarnings);
  const nativeGraph = normalizeNativeGraph(project.nativeGraph, rootEntries, importWarnings);
  if (nativeGraph && countPlayableEntries(rootEntries) <= 1) {
    const projectedEntries = buildNativeGraphFallbackEntries(nativeGraph);
    if (projectedEntries.length > 0) rootEntries = projectedEntries;
  }
  const projection = buildLegacyProjection(projectType, rootEntries);
  const rootImage = normalizeLocalFilePath(project.rootImage);
  const thumbnailImage = normalizeLocalFilePath(project.thumbnailImage ?? (nativeGraph ? project.rootImage : null));
  const nativeTitle = nativeGraph?.document?.title;

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    version: Math.max(project.version ?? 1, rootEntries.length > 0 ? 2 : 1),
    projectName,
    packMetadata: packMetadata.title
      ? packMetadata
      : normalizePackMetadata({ ...packMetadata, title: typeof nativeTitle === 'string' ? nativeTitle : '' }),
    rootName: project.rootName ?? (projectType === 'pack' ? 'Menu racine' : ''),
    projectType,
    rootAudio: normalizeLocalFilePath(project.rootAudio),
    rootImage,
    treeColor: normalizeTreeColor(project.treeColor),
    thumbnailImage,
    sameImage: !!project.sameImage || (!!nativeGraph && !!rootImage && thumbnailImage === rootImage),
    autoGenerateRootImage: !!project.autoGenerateRootImage,
    nightModeAudio: normalizeLocalFilePath(project.nightModeAudio),
    nightModeReturn: project.nightModeReturn ?? null,
    nightModeHomeReturn: project.nightModeHomeReturn ?? null,
    nativeGraph,
    audioProcessing: normalizeAudioProcessing(project.audioProcessing, ['rootAudio', 'nightModeAudio']),
    globalOptions: normalizeOptions(project.globalOptions),
    importWarnings: nativeGraph ? [] : importWarnings,
    rootEntries,
    rootItems: projection.rootItems,
    menus: projection.menus,
  };
}

function replaceEntryTree(entries, entryId, replacer) {
  return entries.map((entry) => {
    if (entry.id === entryId) return replacer(entry);
    if (entry.type !== 'menu') return entry;
    return {
      ...entry,
      children: replaceEntryTree(entry.children ?? [], entryId, replacer),
    };
  });
}

function removeEntryTree(entries, entryId) {
  return entries
    .filter((entry) => entry.id !== entryId)
    .map((entry) => entry.type === 'menu'
      ? { ...entry, children: removeEntryTree(entry.children ?? [], entryId) }
      : entry);
}

function removeEntriesTree(entries, entryIds) {
  return entries
    .filter((entry) => !entryIds.has(entry.id))
    .map((entry) => entry.type === 'menu'
      ? { ...entry, children: removeEntriesTree(entry.children ?? [], entryIds) }
      : entry);
}

function updateNativeGraphStage(graph, stageId, fields) {
  if (!graph || !stageId || !fields || typeof fields !== 'object') return graph;
  const stages = graph?.document?.stageNodes;
  if (!Array.isArray(stages)) return graph;
  const stageIndex = stages.findIndex((stage) => (stage?.uuid || stage?.id) === stageId);
  if (stageIndex < 0) return graph;
  const nextGraph = JSON.parse(JSON.stringify(graph));
  const stage = nextGraph.document.stageNodes[stageIndex];
  if (Object.prototype.hasOwnProperty.call(fields, 'name')) stage.name = fields.name ?? '';
  if (Object.prototype.hasOwnProperty.call(fields, 'audio')) stage.audio = fields.audio ?? null;
  if (Object.prototype.hasOwnProperty.call(fields, 'itemAudio')) stage.audio = fields.itemAudio ?? stage.audio ?? null;
  if (Object.prototype.hasOwnProperty.call(fields, 'image')) stage.image = fields.image ?? null;
  if (Object.prototype.hasOwnProperty.call(fields, 'itemImage')) stage.image = fields.itemImage ?? stage.image ?? null;
  if (Object.prototype.hasOwnProperty.call(fields, 'controlSettings')) {
    stage.controlSettings = { ...(stage.controlSettings ?? {}), ...(fields.controlSettings ?? {}) };
  }
  return nextGraph;
}

function clearNativeGraphMedia(graph, path) {
  const stages = graph?.document?.stageNodes;
  if (!Array.isArray(stages)) return graph;
  let changed = false;
  const nextStages = stages.map((stage) => {
    let nextStage = stage;
    if (isSameMediaPath(stage?.audio, path)) {
      nextStage = { ...nextStage, audio: null };
      changed = true;
    }
    if (isSameMediaPath(stage?.image, path)) {
      nextStage = { ...nextStage, image: null };
      changed = true;
    }
    return nextStage;
  });
  if (!changed) return graph;
  return {
    ...graph,
    document: {
      ...graph.document,
      stageNodes: nextStages,
    },
  };
}

function clearAudioProcessingField(entry, field) {
  if (!entry.audioProcessing?.[field]) return entry;
  const audioProcessing = { ...entry.audioProcessing };
  delete audioProcessing[field];
  return {
    ...entry,
    audioProcessing: Object.keys(audioProcessing).length > 0 ? audioProcessing : {},
  };
}

function clearEntryMediaReferences(entry, path) {
  if (!entry || typeof entry !== 'object') return entry;
  let next = { ...entry };

  function clearField(field) {
    if (!isSameMediaPath(next[field], path)) return;
    next = { ...next, [field]: null };
    if (field === 'audio' || field === 'itemAudio' || field === 'afterPlaybackPromptAudio') {
      next = clearAudioProcessingField(next, field);
    }
  }

  if (next.type === 'menu') {
    clearField('audio');
    clearField('image');
    next.nativeGraph = clearNativeGraphMedia(next.nativeGraph, path);
    next.children = (next.children ?? []).map((child) => clearEntryMediaReferences(child, path));
    return next;
  }

  if (next.type === 'story') {
    clearField('audio');
    clearField('itemAudio');
    clearField('itemImage');
    clearField('afterPlaybackPromptAudio');
    if (Array.isArray(next.afterPlaybackSequence)) {
      next.afterPlaybackSequence = next.afterPlaybackSequence.map((step) => ({
        ...step,
        audio: isSameMediaPath(step?.audio, path) ? null : step.audio,
        image: isSameMediaPath(step?.image, path) ? null : step.image,
      }));
    }
    if (next.afterPlaybackHomeStep) {
      next.afterPlaybackHomeStep = {
        ...next.afterPlaybackHomeStep,
        audio: isSameMediaPath(next.afterPlaybackHomeStep.audio, path) ? null : next.afterPlaybackHomeStep.audio,
        image: isSameMediaPath(next.afterPlaybackHomeStep.image, path) ? null : next.afterPlaybackHomeStep.image,
      };
    }
    return next;
  }

  if (next.type === 'zip') {
    clearField('zipPath');
    clearField('coverImage');
    clearField('coverAudio');
  }
  return next;
}

function appendEntryToTree(entries, containerId, nextEntry) {
  if (containerId == null) return [...entries, normalizeEntry(nextEntry)];
  return entries.map((entry) => {
    if (entry.type !== 'menu') return entry;
    if (entry.id === containerId) {
      return { ...entry, children: [...(entry.children ?? []), normalizeEntry(nextEntry)] };
    }
    return { ...entry, children: appendEntryToTree(entry.children ?? [], containerId, nextEntry) };
  });
}

function replaceContainerChildren(entries, containerId, visibleEntries) {
  if (containerId == null) {
    return visibleEntries.map(normalizeEntry);
  }

  return entries.map((entry) => {
    if (entry.type !== 'menu') return entry;
    if (entry.id === containerId) {
      return {
        ...entry,
        children: visibleEntries.map(normalizeEntry),
      };
    }
    return {
      ...entry,
      children: replaceContainerChildren(entry.children ?? [], containerId, visibleEntries),
    };
  });
}

function extractEntry(entries, entryId) {
  for (const entry of entries) {
    if (entry.id === entryId) return entry;
    if (entry.type === 'menu') {
      const nested = extractEntry(entry.children ?? [], entryId);
      if (nested) return nested;
    }
  }
  return null;
}

function basenameWithoutExtension(path) {
  return String(path || '')
    .replace(/\\/g, '/')
    .replace(/.*\//, '')
    .replace(/\.[^/.]+$/, '');
}

function cleanProjectName(value, fallback = 'Nouveau projet') {
  const cleaned = String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[<>:"/\\|?*]/g, ' ')
    // Préserve les underscores simples (autorisés dans les noms de fichiers),
    // ne réduit que les séquences multiples issues de sanitisation amont.
    .replace(/_{2,}/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned || fallback;
}

function normalizePackVersion(value) {
  const parsed = Number.parseInt(String(value ?? '').replace(/\D/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function normalizePackMinAge(value) {
  const parsed = String(value ?? '').match(/\d+/)?.[0] ?? '';
  return parsed || DEFAULT_PACK_METADATA.minAge;
}

export function normalizePackMetadata(value = {}) {
  const metadata = value && typeof value === 'object' ? value : {};
  const namingMode = metadata.namingMode === 'legacy' ? 'legacy' : 'convention';
  return {
    title: String(metadata.title ?? '').trim(),
    author: String(metadata.author ?? '').trim(),
    version: normalizePackVersion(metadata.version),
    minAge: normalizePackMinAge(metadata.minAge ?? metadata.age),
    producer: String(metadata.producer ?? '').trim(),
    bonus: String(metadata.bonus ?? '').trim(),
    description: String(metadata.description ?? '').trim(),
    namingMode,
    legacyExportName: String(metadata.legacyExportName ?? '').trim(),
    legacyName: String(metadata.legacyName ?? '').trim(),
  };
}

function buildPackMetadataFromLegacy(project = {}) {
  const oldName = String(project.name ?? '').trim();
  const source = String(project.packConventionSource ?? '').trim();
  const parsed = parseConventionName(oldName) ?? parseConventionName(source);

  if (parsed) {
    return normalizePackMetadata({
      ...parsed,
      version: project.packVersion ?? parsed.version,
      minAge: project.packMinAge || parsed.minAge,
      description: project.packDescription ?? '',
      namingMode: 'convention',
      legacyName: oldName,
    });
  }

  return normalizePackMetadata({
    title: oldName,
    version: project.packVersion ?? 1,
    minAge: project.packMinAge || DEFAULT_PACK_METADATA.minAge,
    description: project.packDescription ?? '',
    namingMode: oldName ? 'legacy' : 'convention',
    legacyExportName: oldName,
    legacyName: oldName,
  });
}

export function migrateProjectData(rawData = {}, { savePath = null } = {}) {
  const source = rawData && typeof rawData === 'object' ? rawData : {};
  const hasNewMetadata = source.packMetadata && typeof source.packMetadata === 'object';
  const packMetadata = normalizePackMetadata(
    hasNewMetadata
      ? {
          ...source.packMetadata,
          version: source.packMetadata.version ?? source.packVersion,
          minAge: source.packMetadata.minAge ?? source.packMinAge,
          description: source.packMetadata.description ?? source.packDescription,
        }
      : buildPackMetadataFromLegacy(source),
  );

  const saveStem = basenameWithoutExtension(savePath);
  const legacyName = String(source.name ?? '').trim();
  const legacyNameIsConvention = !!parseConventionName(legacyName);
  const localLegacyName = legacyName && !legacyNameIsConvention ? legacyName : '';
  const projectName = cleanProjectName(
    source.projectName || saveStem || localLegacyName,
    'nouveau-projet',
  );

  const {
    name: _name,
    packVersion: _packVersion,
    packDescription: _packDescription,
    packMinAge: _packMinAge,
    packConventionSource: _packConventionSource,
    ...rest
  } = source;

  return {
    ...rest,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectName,
    packMetadata,
  };
}

function walkEntries(entries, visitor, ancestors = []) {
  for (const entry of entries ?? []) {
    visitor(entry, ancestors);
    if (entry.type === 'menu') {
      walkEntries(entry.children ?? [], visitor, [...ancestors, entry]);
    }
  }
}

export function normalizeProjectData(project) {
  return normalizeBaseProject(project);
}

export function projectToSerializable(project) {
  const normalized = normalizeBaseProject(project);
  return {
    ...normalized,
    version: Math.max(normalized.version ?? 1, 2),
  };
}

export function projectToRustExport(project) {
  const serializable = projectToSerializable(project);
  const packMetadata = normalizePackMetadata(serializable.packMetadata);
  return {
    ...serializable,
    name: getExportPackName(packMetadata),
    packVersion: packMetadata.version,
    packDescription: packMetadata.description,
  };
}

export function createMenuEntry(fields = {}) {
  return normalizeMenuEntry({ name: 'Nouveau dossier', ...fields });
}

export function createStoryEntry(fields = {}) {
  return normalizeStoryEntry(fields);
}

export function createZipEntry(fields = {}) {
  return normalizeZipEntry(fields);
}

export function updateProjectRootEntries(project, nextRootEntries) {
  return normalizeBaseProject({ ...project, rootEntries: nextRootEntries });
}

export function appendEntry(project, containerId, entry) {
  return updateProjectRootEntries(project, appendEntryToTree(project.rootEntries ?? [], containerId, entry));
}

export function deepCloneEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const cloned = { ...entry, id: makeId() };
  if (Array.isArray(cloned.children)) {
    cloned.children = cloned.children.map(deepCloneEntry);
  }
  return cloned;
}

export function shallowCloneEntry(entry) {
  const clone = { ...entry, id: makeId() };
  if (Array.isArray(clone.children)) clone.children = [];
  return clone;
}

function insertEntryAfterInTree(entries, anchorId, newEntry) {
  const result = [];
  for (const entry of entries) {
    const updated = entry.type === 'menu' && entry.children
      ? { ...entry, children: insertEntryAfterInTree(entry.children, anchorId, newEntry) }
      : entry;
    result.push(updated);
    if (entry.id === anchorId) result.push(normalizeEntry(newEntry));
  }
  return result;
}

function insertEntryBeforeInTree(entries, anchorId, newEntry) {
  const result = [];
  for (const entry of entries) {
    if (entry.id === anchorId) result.push(normalizeEntry(newEntry));
    const updated = entry.type === 'menu' && entry.children
      ? { ...entry, children: insertEntryBeforeInTree(entry.children, anchorId, newEntry) }
      : entry;
    result.push(updated);
  }
  return result;
}

export function insertEntryAfter(project, anchorId, newEntry) {
  return updateProjectRootEntries(project, insertEntryAfterInTree(project.rootEntries ?? [], anchorId, newEntry));
}

export function moveEntryNextTo(project, entryId, anchorId, position) {
  const movedEntry = extractEntry(project.rootEntries ?? [], entryId);
  if (!movedEntry) return project;
  const withoutEntry = removeEntryTree(project.rootEntries ?? [], entryId);
  const moved = position === 'before'
    ? insertEntryBeforeInTree(withoutEntry, anchorId, movedEntry)
    : insertEntryAfterInTree(withoutEntry, anchorId, movedEntry);
  return updateProjectRootEntries(project, moved);
}

function appendEntriesToContainer(rootEntries, containerId, newEntries) {
  if (containerId == null) return [...rootEntries, ...newEntries];
  return rootEntries.map((entry) => {
    if (entry.type !== 'menu') return entry;
    if (entry.id === containerId) return { ...entry, children: [...(entry.children ?? []), ...newEntries] };
    return { ...entry, children: appendEntriesToContainer(entry.children ?? [], containerId, newEntries) };
  });
}

export function appendEntries(project, containerId, entries) {
  const normalized = entries.map(normalizeEntry);
  return updateProjectRootEntries(project, appendEntriesToContainer(project.rootEntries ?? [], containerId, normalized));
}

export function cutPasteEntries(project, sourceIds, targetMenuId) {
  const entries = sourceIds.map((id) => findEntryById(project, id)).filter(Boolean);
  let p = project;
  for (const id of sourceIds) p = removeEntry(p, id);
  return appendEntries(p, targetMenuId, entries);
}

export function updateEntry(project, entryId, fields) {
  const audioFields = ['audio', 'itemAudio', 'afterPlaybackPromptAudio'];
  let nativeStageId = null;
  const nextRootEntries = replaceEntryTree(project.rootEntries ?? [], entryId, (entry) => {
      const next = { ...entry, ...fields };
      if (!Object.prototype.hasOwnProperty.call(fields, 'audioProcessing')) {
        for (const field of audioFields) {
          if (Object.prototype.hasOwnProperty.call(fields, field) && next.audioProcessing?.[field]) {
            next.audioProcessing = { ...next.audioProcessing };
            delete next.audioProcessing[field];
          }
        }
      }
      const normalized = normalizeEntry(next);
      nativeStageId = normalized.nativeStageId ?? null;
      return normalized;
    });
  let nextProject = updateProjectRootEntries(project, nextRootEntries);
  if (nativeStageId && nextProject.nativeGraph?.preserveForRoundTrip === true) {
    nextProject = normalizeBaseProject({
      ...nextProject,
      nativeGraph: updateNativeGraphStage(nextProject.nativeGraph, nativeStageId, fields),
    });
  }
  return nextProject;
}

export function clearMediaReferences(project, path) {
  if (!path) return project;
  let next = { ...project };
  for (const field of ['rootAudio', 'rootImage', 'thumbnailImage', 'nightModeAudio']) {
    if (isSameMediaPath(next[field], path)) {
      next[field] = null;
      if ((field === 'rootAudio' || field === 'nightModeAudio') && next.audioProcessing?.[field]) {
        next.audioProcessing = { ...next.audioProcessing };
        delete next.audioProcessing[field];
      }
    }
  }
  next.nativeGraph = clearNativeGraphMedia(next.nativeGraph, path);
  next.rootEntries = (next.rootEntries ?? []).map((entry) => clearEntryMediaReferences(entry, path));
  return normalizeBaseProject(next);
}

export function removeEntry(project, entryId) {
  return updateProjectRootEntries(project, removeEntryTree(project.rootEntries ?? [], entryId));
}

export function removeEntries(project, entryIds) {
  const ids = new Set([...entryIds].filter((id) => id && id !== 'root'));
  if (ids.size === 0) return project;
  return updateProjectRootEntries(project, removeEntriesTree(project.rootEntries ?? [], ids));
}

export function replaceEntryWithEntries(project, containerId, entryId, replacementEntries) {
  const normalized = replacementEntries.map(normalizeEntry);
  if (containerId == null) {
    const nextEntries = [];
    for (const entry of project.rootEntries ?? []) {
      if (entry.id === entryId) nextEntries.push(...normalized);
      else nextEntries.push(entry);
    }
    return updateProjectRootEntries(project, nextEntries);
  }

  const nextEntries = replaceEntryTree(project.rootEntries ?? [], containerId, (menu) => {
    if (menu.type !== 'menu') return menu;
    const children = [];
    for (const child of menu.children ?? []) {
      if (child.id === entryId) children.push(...normalized);
      else children.push(child);
    }
    return { ...menu, children };
  });
  return updateProjectRootEntries(project, nextEntries);
}

export function reorderRootVisibleEntries(project, newItems) {
  return updateProjectRootEntries(project, replaceContainerChildren(project.rootEntries ?? [], null, newItems));
}

export function reorderTopLevelMenus(project, newMenus) {
  const rootItems = (project.rootEntries ?? []).filter((entry) => entry.type !== 'menu');
  return updateProjectRootEntries(project, [...rootItems, ...newMenus.map(normalizeEntry)]);
}

export function reorderMenuVisibleChildren(project, menuId, newItems) {
  return updateProjectRootEntries(project, replaceContainerChildren(project.rootEntries ?? [], menuId, newItems));
}

export function moveEntryToContainer(project, entryId, toContainerId) {
  const movedEntry = extractEntry(project.rootEntries ?? [], entryId);
  if (!movedEntry) return project;
  const withoutEntry = removeEntryTree(project.rootEntries ?? [], entryId);
  const moved = appendEntryToTree(withoutEntry, toContainerId, movedEntry);
  return updateProjectRootEntries(project, moved);
}

export function findEntryById(project, entryId, projectIndex = null) {
  if (entryId === 'root') return null;
  if (projectIndex) return projectIndex.entryById.get(entryId) ?? null;
  return extractEntry(project.rootEntries ?? [], entryId);
}

export function findParentMenuId(project, entryId, projectIndex = null) {
  if (projectIndex) return projectIndex.parentMenuById.get(entryId) ?? null;
  let parentId = null;
  walkEntries(project.rootEntries ?? [], (entry, ancestors) => {
    if (entry.id === entryId) {
      const directParent = ancestors[ancestors.length - 1] ?? null;
      parentId = directParent?.type === 'menu' ? directParent.id : null;
    }
  });
  return parentId;
}

export function findEntryPath(project, entryId, projectIndex = null) {
  if (entryId === 'root') return [];
  if (projectIndex) return projectIndex.pathById.get(entryId) ?? null;

  function visit(entries, ancestors = []) {
    for (const entry of entries ?? []) {
      const path = [...ancestors, entry];
      if (entry.id === entryId) return path;
      if (entry.type === 'menu') {
        const nested = visit(entry.children ?? [], path);
        if (nested) return nested;
      }
    }
    return null;
  }

  return visit(project.rootEntries ?? []);
}

export function buildSelectedNode(project, selectedId, projectIndex = null) {
  if (selectedId === 'root') {
    const simpleStory = projectIndex?.firstSimpleStory
      ?? (project.rootEntries?.find((entry) => entry.type === 'story') ?? null);
    return { type: 'root', ...project, storyAudio: simpleStory?.audio ?? null };
  }

  const entry = findEntryById(project, selectedId, projectIndex);
  if (!entry) return null;
  if (entry.type === 'menu') {
    return {
      type: 'menu',
      ...entry,
      items: (entry.children ?? []).filter((child) => child.type !== 'menu'),
    };
  }
  return entry;
}

export function visitProjectEntries(project, visitor, projectIndex = null) {
  if (projectIndex) {
    for (const flatEntry of projectIndex.flatEntries) {
      const path = projectIndex.pathById.get(flatEntry.id) ?? [flatEntry.entry];
      visitor(flatEntry.entry, path.slice(0, -1));
    }
    return;
  }
  walkEntries(project.rootEntries ?? [], visitor);
}

export function collectAllMenus(project, projectIndex = null) {
  if (projectIndex) {
    return projectIndex.menuEntries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      importedContinuation: entry.importedContinuation ?? null,
    }));
  }
  const menus = [];
  walkEntries(project.rootEntries ?? [], (entry) => {
    if (entry.type === 'menu') {
      menus.push({
        id: entry.id,
        name: entry.name,
        importedContinuation: entry.importedContinuation ?? null,
      });
    }
  });
  return menus;
}

export function collectAllStories(project, projectIndex = null) {
  const stories = [];
  if (projectIndex) {
    for (const flat of projectIndex.flatEntries) {
      if (flat.type === 'story') {
        stories.push({
          id: flat.entry.id,
          name: flat.entry.name,
          hasAfterPlaybackHomeStep: !!flat.entry.afterPlaybackHomeStep,
        });
      }
    }
    return stories;
  }
  walkEntries(project.rootEntries ?? [], (entry) => {
    if (entry.type === 'story') {
      stories.push({
        id: entry.id,
        name: entry.name,
        hasAfterPlaybackHomeStep: !!entry.afterPlaybackHomeStep,
      });
    }
  });
  return stories;
}

export function getPlayableDescendantCount(projectIndex, entryId) {
  if (!projectIndex || !entryId) return 0;
  return projectIndex.playableDescendantCountById.get(entryId) ?? 0;
}

export function collectProjectAudioPaths(project) {
  const audioPaths = [];
  if (project.rootAudio) audioPaths.push(project.rootAudio);
  if (project.nightModeAudio) audioPaths.push(project.nightModeAudio);
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'menu' && entry.audio) audioPaths.push(entry.audio);
    if (entry.type === 'story') {
      if (entry.audio) audioPaths.push(entry.audio);
      if (entry.itemAudio) audioPaths.push(entry.itemAudio);
      if (entry.afterPlaybackPromptAudio) audioPaths.push(entry.afterPlaybackPromptAudio);
      for (const step of entry.afterPlaybackSequence ?? []) {
        if (step.audio) audioPaths.push(step.audio);
      }
      if (entry.afterPlaybackHomeStep?.audio) audioPaths.push(entry.afterPlaybackHomeStep.audio);
    }
  });
  return audioPaths;
}
