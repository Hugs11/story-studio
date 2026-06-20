import { normalizeNavigationTarget } from '../navigationTargets.js';
import { PACK_AUDIO_EDGE_SILENCE_SECONDS } from '../../config/audioProcessing.js';
import { getExportPackName, parseConventionName } from '../../utils/packConvention.js';
import { basenameNoExt, normalizeWindowsPath, pathKey } from '../../utils/fileUtils.js';

// Canonical project shape:
// - `rootEntries` is the only saved/runtime tree for project content.
// - Menu children live in `children`.
// - Imported pack projections can expose `entries`; normalization maps them to
//   `rootEntries` or `children`.
// - Legacy `rootItems` / `menus` are read only as migration inputs.
export const PROJECT_SCHEMA_VERSION = 3;
export const SILENCE_MODES = Object.freeze(['off', 'add', 'normalize']);

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

export function makeId() {
  return crypto.randomUUID();
}

function normalizeLocalFilePath(value) {
  return normalizeWindowsPath(value);
}

function mediaPathKey(value) {
  return typeof value === 'string' ? pathKey(value) : '';
}

export function isSameMediaPath(a, b) {
  const ak = mediaPathKey(a);
  return !!ak && ak === mediaPathKey(b);
}

function normalizeOptions(options) {
  const explicitSilenceMode = typeof options?.silenceMode === 'string'
    ? options.silenceMode.toLowerCase()
    : null;
  const silenceMode = SILENCE_MODES.includes(explicitSilenceMode)
    ? explicitSilenceMode
    : Object.prototype.hasOwnProperty.call(options ?? {}, 'addSilence')
      ? (options?.addSilence ? 'add' : 'off')
      : 'normalize';
  return {
    silenceMode,
    harmonizeLoudness: options?.harmonizeLoudness ?? true,
    autoNext: options?.autoNext ?? false,
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
  for (const field of ['__allAudio', ...fields]) {
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

export function normalizeStoryEntry(entry = {}) {
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

export function normalizeZipEntry(entry = {}) {
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

export function normalizeMenuEntry(entry = {}) {
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

export function normalizeEntry(entry = {}) {
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

function inferProjectType(project, rootEntries) {
  if (project?.projectType) return project.projectType;
  return rootEntries.length > 0 ? 'pack' : null;
}

function hasLegacyRootEntries(project) {
  return (Array.isArray(project?.rootItems) && project.rootItems.length > 0)
    || (Array.isArray(project?.menus) && project.menus.length > 0);
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

function normalizePackMetadata(value = {}) {
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

  const saveStem = basenameNoExt(savePath);
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

export function normalizeBaseProject(project = {}) {
  const packMetadata = normalizePackMetadata(project.packMetadata ?? buildPackMetadataFromLegacy(project));
  const projectName = cleanProjectName(project.projectName || project.name, '');
  const shouldUseRootEntries = Array.isArray(project.rootEntries)
    && (project.rootEntries.length > 0 || !hasLegacyRootEntries(project));
  let rootEntries = shouldUseRootEntries
    ? project.rootEntries.map(normalizeEntry)
    : legacyRootEntries(project);
  const projectType = inferProjectType(project, rootEntries);
  const importWarnings = normalizeImportWarnings(project.importWarnings);
  const nativeGraph = normalizeNativeGraph(project.nativeGraph, rootEntries, importWarnings);
  if (nativeGraph && countPlayableEntries(rootEntries) <= 1) {
    const projectedEntries = buildNativeGraphFallbackEntries(nativeGraph);
    if (projectedEntries.length > 0) rootEntries = projectedEntries;
  }
  const rootImage = normalizeLocalFilePath(project.rootImage);
  const thumbnailImage = normalizeLocalFilePath(project.thumbnailImage ?? (nativeGraph ? project.rootImage : null));
  const nativeTitle = nativeGraph?.document?.title;
  const endNodeName = String(project.endNodeName ?? '').trim() === 'Nœud de fin'
    ? 'Message de fin'
    : (project.endNodeName ?? 'Message de fin');

  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    version: Math.max(project.version ?? 1, rootEntries.length > 0 ? 2 : 1),
    projectName,
    packMetadata: packMetadata.title
      ? packMetadata
      : normalizePackMetadata({ ...packMetadata, title: typeof nativeTitle === 'string' ? nativeTitle : '' }),
    rootName: project.rootName ?? (projectType === 'pack' ? 'Menu racine' : ''),
    endNodeName,
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
  };
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
  if (serializable.projectType === 'simple' && !String(packMetadata.title || '').trim()) {
    const fallback = String(serializable.projectName || '').trim();
    if (fallback) packMetadata.title = fallback;
  }
  return {
    ...serializable,
    name: getExportPackName(packMetadata),
    packVersion: packMetadata.version,
    packDescription: packMetadata.description,
    globalOptions: {
      ...serializable.globalOptions,
      silenceMode: serializable.globalOptions.silenceMode,
      addSilenceDurationSec: PACK_AUDIO_EDGE_SILENCE_SECONDS,
    },
  };
}
