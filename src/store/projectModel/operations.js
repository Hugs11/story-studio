import { isSameMediaPath, makeId, normalizeBaseProject, normalizeEntry } from './schema.js';
import { extractEntry, findEntryById } from './index.js';

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
  const nextGraph = structuredClone(graph);
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

function clearEntryMediaReferences(entry, path) {
  if (!entry || typeof entry !== 'object') return entry;
  let next = { ...entry };

  function clearField(field) {
    if (!isSameMediaPath(next[field], path)) return;
    next = { ...next, [field]: null };
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

export function updateProjectRootEntries(project, nextRootEntries) {
  return normalizeBaseProject({ ...project, rootEntries: nextRootEntries });
}

export function appendEntry(project, containerId, entry) {
  return updateProjectRootEntries(project, appendEntryToTree(project.rootEntries ?? [], containerId, entry));
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
  let nativeStageId = null;
  const nextRootEntries = replaceEntryTree(project.rootEntries ?? [], entryId, (entry) => {
      const next = { ...entry, ...fields };
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
