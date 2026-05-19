import { buildProjectIndex, getPlayableDescendantCount, visitProjectEntries } from './projectModel';
import { decodeNavigationMenuId, decodeNavigationStoryId, isCurrentMenuNavigationTarget, isNextStoryNavigationTarget, isRootNavigationTarget, isStoryHomeStepNavigationTarget, isStoryNavigationTarget, normalizeNavigationTarget } from './navigationTargets';

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBrokenPath(value, fileAudit = {}) {
  return hasPath(value) && fileAudit[value] === false;
}

function isAccessiblePath(value, fileAudit = {}) {
  return hasPath(value) && fileAudit[value] !== false;
}

function labelOrFallback(value, fallback) {
  return (value || '').trim() || fallback;
}

function pushIssue(issues, id, status, text) {
  issues.push({ id, status, text });
}

function collectProjectGraphStats(projectIndex) {
  return {
    entryIdCounts: projectIndex.entryIdCounts,
    menuMap: new Map(projectIndex.menuEntries.map((entry) => [entry.id, entry])),
    firstSimpleStory: projectIndex.firstSimpleStory,
    rootPlayableCount: projectIndex.rootPlayableCount,
  };
}

function resolveNavigationMenuTarget(target, currentMenuId = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return currentMenuId;
  if (isCurrentMenuNavigationTarget(normalized)) return currentMenuId;
  if (isRootNavigationTarget(normalized)) return 'root';
  return decodeNavigationMenuId(normalized);
}

function validateNavigationTarget(issues, id, label, target, projectIndex, menuIds) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return;
  if (isRootNavigationTarget(normalized) || isCurrentMenuNavigationTarget(normalized) || isNextStoryNavigationTarget(normalized)) {
    return;
  }
  if (isStoryNavigationTarget(normalized)) {
    const storyId = decodeNavigationStoryId(normalized);
    const entry = storyId ? projectIndex.entryById.get(storyId) : null;
    if (!entry || entry.type !== 'story') {
      pushIssue(issues, id, 'error', `${label} — destination histoire introuvable`);
    } else if (isStoryHomeStepNavigationTarget(normalized) && !entry.afterPlaybackHomeStep) {
      pushIssue(issues, id, 'error', `${label} - retour de fin introuvable pour cette histoire`);
    }
    return;
  }
  const menuId = decodeNavigationMenuId(normalized);
  if (!menuId || !menuIds.has(menuId)) {
    pushIssue(issues, id, 'error', `${label} — destination dossier introuvable`);
  } else if (getPlayableDescendantCount(projectIndex, menuId) === 0) {
    pushIssue(issues, id, 'error', `${label} — destination dossier vide ou non jouable`);
  }
}

function validateStorySelectionItem(issues, item, fallbackName, fileAudit) {
  const name = labelOrFallback(item?.name, fallbackName);
  const isAutoplay = !!item?.controlSettings?.autoplay;
  if (!hasPath(item?.audio)) pushIssue(issues, item?.id ?? null, 'error', `${name} — histoire manquante`);
  else if (isBrokenPath(item?.audio, fileAudit)) pushIssue(issues, item?.id ?? null, 'error', `${name} — histoire introuvable ou inaccessible`);
  if (!isAutoplay) {
    if (!hasPath(item?.itemImage)) pushIssue(issues, item?.id ?? null, 'error', `${name} — image manquante`);
    else if (isBrokenPath(item?.itemImage, fileAudit)) pushIssue(issues, item?.id ?? null, 'error', `${name} — image introuvable ou inaccessible`);
    if (!hasPath(item?.itemAudio)) pushIssue(issues, item?.id ?? null, 'error', `${name} — audio titre manquant`);
    else if (isBrokenPath(item?.itemAudio, fileAudit)) pushIssue(issues, item?.id ?? null, 'error', `${name} — audio titre introuvable ou inaccessible`);
  }
  if (hasPath(item?.afterPlaybackPromptAudio) && isBrokenPath(item?.afterPlaybackPromptAudio, fileAudit)) {
    pushIssue(issues, item?.id ?? null, 'error', `${name} — audio de fin d'histoire introuvable ou inaccessible`);
  }
  for (const [index, step] of (item?.afterPlaybackSequence ?? []).entries()) {
    if (!hasPath(step?.audio)) {
      pushIssue(issues, item?.id ?? null, 'error', `${name} — audio de fin ${index + 1} manquant`);
    } else if (isBrokenPath(step.audio, fileAudit)) {
      pushIssue(issues, item?.id ?? null, 'error', `${name} — audio de fin ${index + 1} introuvable ou inaccessible`);
    }
  }
}

function validateZipItem(issues, item, fallbackName, fileAudit) {
  const name = labelOrFallback(item?.name, fallbackName);
  if (!hasPath(item?.zipPath)) pushIssue(issues, item?.id ?? null, 'error', `${name} — zip manquant`);
  else if (isBrokenPath(item?.zipPath, fileAudit)) pushIssue(issues, item?.id ?? null, 'error', `${name} — zip introuvable ou inaccessible`);
}

export function getProjectValidationIssues(project, fileAudit = {}, providedProjectIndex = null) {
  const issues = [];
  const projectType = project?.projectType;
  const rootName = labelOrFallback(project?.name, 'Nom de mon histoire');
  const nightMode = !!project?.globalOptions?.nightMode;
  const hasEndNode = nightMode || !!project?.nightModeAudio || !!project?.globalOptions?.endNode;
  const projectIndex = providedProjectIndex ?? buildProjectIndex(project);
  const { entryIdCounts, menuMap, firstSimpleStory, rootPlayableCount } = collectProjectGraphStats(projectIndex);
  const menuIds = new Set(menuMap.keys());

  if (!projectType) {
    pushIssue(issues, 'root', 'error', 'Aucun type de projet selectionne.');
    return issues;
  }

  for (const warning of project?.importWarnings ?? []) {
    pushIssue(
      issues,
      warning?.entryId ?? 'root',
      'error',
      warning?.message || 'Transition importee non modelisee.',
    );
  }

  for (const [entryId, count] of entryIdCounts.entries()) {
    if (count > 1) {
      pushIssue(issues, entryId, 'error', `Identifiant duplique — ${count} elements partagent l'id ${entryId}`);
    }
  }
  if (entryIdCounts.has('root')) {
    pushIssue(issues, 'root', 'error', "Identifiant reserve utilise — aucun element ne doit porter l'id root");
  }

  if (!hasPath(project?.rootAudio)) pushIssue(issues, 'root', 'error', `Menu racine — audio intro manquant`);
  else if (isBrokenPath(project?.rootAudio, fileAudit)) pushIssue(issues, 'root', 'error', `Menu racine — audio intro introuvable ou inaccessible`);
  if (!hasPath(project?.rootImage)) pushIssue(issues, 'root', 'error', `Menu racine — image de couverture manquante`);
  else if (isBrokenPath(project?.rootImage, fileAudit)) pushIssue(issues, 'root', 'error', `Menu racine — image de couverture introuvable ou inaccessible`);
  if (projectType === 'pack') {
    if (!hasPath(project?.thumbnailImage)) pushIssue(issues, 'root', 'error', `Menu racine — image bibliothèque manquante (cocher « même image » ou en choisir une)`);
    else if (isBrokenPath(project?.thumbnailImage, fileAudit)) pushIssue(issues, 'root', 'error', `Menu racine — image bibliothèque introuvable ou inaccessible`);
  }
  if (hasEndNode && !hasPath(project?.nightModeAudio)) {
    pushIssue(issues, 'end-node', 'error', `Nœud de fin — audio manquant`);
  } else if (hasEndNode && isBrokenPath(project?.nightModeAudio, fileAudit)) {
    pushIssue(issues, 'end-node', 'error', `Nœud de fin — audio introuvable ou inaccessible`);
  }

  if (projectType === 'simple') {
    if (!hasPath(firstSimpleStory?.audio)) {
      pushIssue(issues, 'root', 'error', `${rootName} — histoire manquante`);
    } else if (isBrokenPath(firstSimpleStory?.audio, fileAudit)) {
      pushIssue(issues, 'root', 'error', `${rootName} — histoire introuvable ou inaccessible`);
    }
    return issues;
  }

  visitProjectEntries(project, (entry, ancestors) => {
    const entryLabel = labelOrFallback(entry?.name, entry?.type === 'menu' ? 'Collection' : 'Element');
    const pathLabel = [...ancestors.map((parent) => labelOrFallback(parent?.name, 'Collection')), entryLabel]
      .join(' / ');
    const parentMenu = ancestors.length > 0 ? ancestors[ancestors.length - 1] : null;
    const entryId = typeof entry?.id === 'string' ? entry.id.trim() : '';
    if (!entryId) {
      pushIssue(issues, null, 'error', `${pathLabel} — identifiant interne manquant`);
    } else if (entryId === 'root') {
      pushIssue(issues, entryId, 'error', `${pathLabel} — identifiant reserve invalide`);
    }
    if (entry?.type !== 'menu' && entry?.type !== 'story' && entry?.type !== 'zip') {
      pushIssue(issues, entry?.id ?? null, 'error', `${pathLabel} — type d'element non pris en charge`);
      return;
    }

    if (entry?.type === 'menu') {
      const isSilentImportedContinuation = !!entry?.importedContinuation;
      if (!hasPath(entry?.audio) && !isSilentImportedContinuation) pushIssue(issues, entry?.id ?? null, 'error', `${pathLabel} — audio manquant`);
      else if (isBrokenPath(entry?.audio, fileAudit)) pushIssue(issues, entry?.id ?? null, 'error', `${pathLabel} — audio introuvable ou inaccessible`);
      if (!hasPath(entry?.image) && !entry?.autoBlackImage) {
        pushIssue(issues, entry?.id ?? null, 'error', `${pathLabel} — image manquante`);
      } else if (isBrokenPath(entry?.image, fileAudit)) {
        pushIssue(issues, entry?.id ?? null, 'error', `${pathLabel} — image introuvable ou inaccessible`);
      }
      if (getPlayableDescendantCount(projectIndex, entry.id) === 0) {
        pushIssue(issues, entry?.id ?? null, 'error', `${pathLabel} — collection vide`);
      }
      const menuReturnTarget = resolveNavigationMenuTarget(entry?.returnAfterPlay, entry?.id ?? null);
      if (hasPath(entry?.returnAfterPlay) && menuReturnTarget !== 'root' && menuReturnTarget && !menuIds.has(menuReturnTarget)) {
        pushIssue(issues, entry?.id ?? null, 'error', `${entryLabel} — destination de retour introuvable`);
      } else if (hasPath(entry?.returnAfterPlay) && menuReturnTarget && menuReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, menuReturnTarget) === 0) {
        pushIssue(issues, entry?.id ?? null, 'error', `${entryLabel} — destination de retour vide ou non jouable`);
      }
      validateNavigationTarget(
        issues,
        entry?.id ?? null,
        `${entryLabel} — Accueil du dossier`,
        entry?.returnOnHome,
        projectIndex,
        menuIds,
      );
      return;
    }

    const storyReturnTarget = resolveNavigationMenuTarget(entry?.returnAfterPlay, parentMenu?.id ?? null);
    if (hasPath(entry?.returnAfterPlay) && storyReturnTarget !== 'root' && storyReturnTarget && !menuIds.has(storyReturnTarget)) {
      pushIssue(issues, entry?.id ?? null, 'error', `${entryLabel} — destination de retour introuvable`);
    } else if (hasPath(entry?.returnAfterPlay) && storyReturnTarget && storyReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, storyReturnTarget) === 0) {
      pushIssue(issues, entry?.id ?? null, 'error', `${entryLabel} — destination de retour vide ou non jouable`);
    }

    const homeReturnTarget = resolveNavigationMenuTarget(entry?.returnOnHome, storyReturnTarget);
    if (hasPath(entry?.returnOnHome) && homeReturnTarget !== 'root' && homeReturnTarget && !menuIds.has(homeReturnTarget)) {
      pushIssue(issues, entry?.id ?? null, 'error', `${entryLabel} — destination bouton Accueil introuvable`);
    } else if (hasPath(entry?.returnOnHome) && homeReturnTarget && homeReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, homeReturnTarget) === 0) {
      pushIssue(issues, entry?.id ?? null, 'error', `${entryLabel} — destination bouton Accueil vide ou non jouable`);
    }

    if (!entry?.titleReturnOnHomeNone) {
      validateNavigationTarget(
        issues,
        entry?.id ?? null,
        `${entryLabel} — Accueil du titre`,
        entry?.titleReturnOnHome,
        projectIndex,
        menuIds,
      );
    }

    if (entry?.type === 'zip') validateZipItem(issues, entry, pathLabel, fileAudit);
    else {
      validateStorySelectionItem(issues, entry, pathLabel, fileAudit);
      if (hasPath(entry?.afterPlaybackPromptAudio)) {
        validateNavigationTarget(
          issues,
          entry?.id ?? null,
          `${entryLabel} — OK du prompt final`,
          entry?.afterPlaybackPromptOkTarget,
          projectIndex,
          menuIds,
        );
        if (!entry?.afterPlaybackPromptHomeNone) {
          validateNavigationTarget(
            issues,
            entry?.id ?? null,
            `${entryLabel} — Accueil du prompt final`,
            entry?.afterPlaybackPromptHomeTarget,
            projectIndex,
            menuIds,
          );
        }
      }
      if ((entry?.afterPlaybackSequence ?? []).length > 0) {
        for (const [index, step] of entry.afterPlaybackSequence.entries()) {
          validateNavigationTarget(
            issues,
            entry?.id ?? null,
            `${entryLabel} — OK fin ${index + 1}`,
            step?.okTarget,
            projectIndex,
            menuIds,
          );
          if (!step?.homeFollowsOk && !step?.homeNone) {
            validateNavigationTarget(
              issues,
              entry?.id ?? null,
              `${entryLabel} — Accueil fin ${index + 1}`,
              step?.homeTarget,
              projectIndex,
              menuIds,
            );
          }
        }
      }
    }
  }, projectIndex);

  if (rootPlayableCount === 0) {
    pushIssue(issues, 'root', 'error', 'Le pack ne contient aucune histoire.');
  }
  return issues;
}

export function getGenerateErrors(project, fileAudit = {}) {
  return getProjectValidationIssues(project, fileAudit)
    .filter((issue) => issue.status === 'error')
    .map((issue) => issue.text);
}

export function hasBlockingIssues(project, fileAudit = {}) {
  return getProjectValidationIssues(project, fileAudit).some((issue) => issue.status === 'error');
}

export function getItemValidationStatus(item, fileAudit = {}) {
  if (item.type === 'zip') return isAccessiblePath(item.zipPath, fileAudit) ? 'ok' : 'error';
  if (!isAccessiblePath(item.audio, fileAudit)) return 'error';
  if (!item.controlSettings?.autoplay) {
    if (!isAccessiblePath(item.itemImage, fileAudit)) return 'error';
    if (!isAccessiblePath(item.itemAudio, fileAudit)) return 'error';
  }
  if (hasPath(item.afterPlaybackPromptAudio) && !isAccessiblePath(item.afterPlaybackPromptAudio, fileAudit)) return 'error';
  for (const step of item.afterPlaybackSequence ?? []) {
    if (!isAccessiblePath(step?.audio, fileAudit)) return 'error';
    if (hasPath(step?.image) && !isAccessiblePath(step.image, fileAudit)) return 'error';
  }
  if (item.afterPlaybackHomeStep?.audio && !isAccessiblePath(item.afterPlaybackHomeStep.audio, fileAudit)) return 'error';
  if (item.afterPlaybackHomeStep?.image && !isAccessiblePath(item.afterPlaybackHomeStep.image, fileAudit)) return 'error';
  return 'ok';
}

export function getEndNodeValidationStatus(project, fileAudit = {}) {
  if (!isAccessiblePath(project?.nightModeAudio, fileAudit)) return 'error';
  return 'ok';
}

export function getMenuValidationStatus(menu, fileAudit = {}) {
  if (!menu.importedContinuation && !isAccessiblePath(menu.audio, fileAudit)) return 'error';
  if (!menu.autoBlackImage && !isAccessiblePath(menu.image, fileAudit)) return 'error';
  return 'ok';
}

export function getRootValidationStatus(project, fileAudit = {}) {
  if (!isAccessiblePath(project?.rootAudio, fileAudit)) return 'error';
  if (!isAccessiblePath(project?.rootImage, fileAudit)) return 'error';

  if (project?.projectType === 'pack') {
    if (!isAccessiblePath(project?.thumbnailImage, fileAudit)) return 'error';
    return 'ok';
  }

  if (project?.projectType === 'simple') {
    let story = null;
    visitProjectEntries(project, (entry) => {
      if (!story && entry?.type === 'story') story = entry;
    });
    return isAccessiblePath(story?.audio, fileAudit) ? 'ok' : 'error';
  }

  return 'ok';
}
