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

// status === 'error'   → vraie erreur structurelle (référence cassée, donnée corrompue)
// status === 'warning' → projet en construction (champ manquant, fichier introuvable, contenu vide)
// Les deux bloquent la génération ; seule la couleur d'affichage diffère.
function pushError(issues, id, text) {
  issues.push({ id, status: 'error', text });
}

function pushWarning(issues, id, text) {
  issues.push({ id, status: 'warning', text });
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
      pushError(issues, id, `${label} — destination histoire introuvable`);
    } else if (isStoryHomeStepNavigationTarget(normalized) && !entry.afterPlaybackHomeStep) {
      pushError(issues, id, `${label} - retour de fin introuvable pour cette histoire`);
    }
    return;
  }
  const menuId = decodeNavigationMenuId(normalized);
  if (!menuId || !menuIds.has(menuId)) {
    pushError(issues, id, `${label} — destination dossier introuvable`);
  } else if (getPlayableDescendantCount(projectIndex, menuId) === 0) {
    pushError(issues, id, `${label} — destination dossier vide ou non jouable`);
  }
}

function validateStorySelectionItem(issues, item, fallbackName, fileAudit) {
  const name = labelOrFallback(item?.name, fallbackName);
  const isAutoplay = !!item?.controlSettings?.autoplay;
  if (!hasPath(item?.audio)) pushWarning(issues, item?.id ?? null, `${name} — histoire manquante`);
  else if (isBrokenPath(item?.audio, fileAudit)) pushWarning(issues, item?.id ?? null, `${name} — histoire introuvable ou inaccessible`);
  if (!isAutoplay) {
    if (!hasPath(item?.itemImage)) pushWarning(issues, item?.id ?? null, `${name} — image manquante`);
    else if (isBrokenPath(item?.itemImage, fileAudit)) pushWarning(issues, item?.id ?? null, `${name} — image introuvable ou inaccessible`);
    if (!hasPath(item?.itemAudio)) pushWarning(issues, item?.id ?? null, `${name} — audio titre manquant`);
    else if (isBrokenPath(item?.itemAudio, fileAudit)) pushWarning(issues, item?.id ?? null, `${name} — audio titre introuvable ou inaccessible`);
  }
  if (hasPath(item?.afterPlaybackPromptAudio) && isBrokenPath(item?.afterPlaybackPromptAudio, fileAudit)) {
    pushWarning(issues, item?.id ?? null, `${name} — audio de fin d'histoire introuvable ou inaccessible`);
  }
  for (const [index, step] of (item?.afterPlaybackSequence ?? []).entries()) {
    if (!hasPath(step?.audio)) {
      pushWarning(issues, item?.id ?? null, `${name} — audio de fin ${index + 1} manquant`);
    } else if (isBrokenPath(step.audio, fileAudit)) {
      pushWarning(issues, item?.id ?? null, `${name} — audio de fin ${index + 1} introuvable ou inaccessible`);
    }
  }
}

function validateZipItem(issues, item, fallbackName, fileAudit) {
  const name = labelOrFallback(item?.name, fallbackName);
  if (!hasPath(item?.zipPath)) pushWarning(issues, item?.id ?? null, `${name} — zip manquant`);
  else if (isBrokenPath(item?.zipPath, fileAudit)) pushWarning(issues, item?.id ?? null, `${name} — zip introuvable ou inaccessible`);
}

export function getProjectValidationIssues(project, fileAudit = {}, providedProjectIndex = null) {
  const issues = [];
  const projectType = project?.projectType;
  const rootName = labelOrFallback(project?.projectName || project?.packMetadata?.title, 'Nom de mon histoire');
  const nightMode = !!project?.globalOptions?.nightMode;
  const hasEndNode = nightMode || !!project?.nightModeAudio || !!project?.globalOptions?.endNode;
  const projectIndex = providedProjectIndex ?? buildProjectIndex(project);
  const { entryIdCounts, menuMap, firstSimpleStory, rootPlayableCount } = collectProjectGraphStats(projectIndex);
  const menuIds = new Set(menuMap.keys());

  if (!projectType) {
    pushWarning(issues, 'root', 'Aucun type de projet selectionne.');
    return issues;
  }

  for (const warning of project?.importWarnings ?? []) {
    pushWarning(
      issues,
      warning?.entryId ?? 'root',
      warning?.message || 'Transition importee non modelisee.',
    );
  }

  for (const [entryId, count] of entryIdCounts.entries()) {
    if (count > 1) {
      pushError(issues, entryId, `Identifiant duplique — ${count} elements partagent l'id ${entryId}`);
    }
  }
  if (entryIdCounts.has('root')) {
    pushError(issues, 'root', "Identifiant reserve utilise — aucun element ne doit porter l'id root");
  }

  if (!hasPath(project?.rootAudio)) pushWarning(issues, 'root', `Menu racine — audio intro manquant`);
  else if (isBrokenPath(project?.rootAudio, fileAudit)) pushWarning(issues, 'root', `Menu racine — audio intro introuvable ou inaccessible`);
  if (!hasPath(project?.rootImage)) pushWarning(issues, 'root', `Menu racine — image de couverture manquante`);
  else if (isBrokenPath(project?.rootImage, fileAudit)) pushWarning(issues, 'root', `Menu racine — image de couverture introuvable ou inaccessible`);
  if (projectType === 'pack') {
    if (!hasPath(project?.thumbnailImage)) pushWarning(issues, 'root', `Menu racine — image bibliothèque manquante (cocher « même image » ou en choisir une)`);
    else if (isBrokenPath(project?.thumbnailImage, fileAudit)) pushWarning(issues, 'root', `Menu racine — image bibliothèque introuvable ou inaccessible`);
  } else if (hasPath(project?.thumbnailImage) && isBrokenPath(project?.thumbnailImage, fileAudit)) {
    pushWarning(issues, 'root', `Menu racine — image bibliothèque introuvable ou inaccessible`);
  }
  if (hasEndNode && !hasPath(project?.nightModeAudio)) {
    pushWarning(issues, 'end-node', `Nœud de fin — audio manquant`);
  } else if (hasEndNode && isBrokenPath(project?.nightModeAudio, fileAudit)) {
    pushWarning(issues, 'end-node', `Nœud de fin — audio introuvable ou inaccessible`);
  }

  if (projectType === 'simple') {
    if (!hasPath(firstSimpleStory?.audio)) {
      pushWarning(issues, 'root', `${rootName} — histoire manquante`);
    } else if (isBrokenPath(firstSimpleStory?.audio, fileAudit)) {
      pushWarning(issues, 'root', `${rootName} — histoire introuvable ou inaccessible`);
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
      pushError(issues, null, `${pathLabel} — identifiant interne manquant`);
    } else if (entryId === 'root') {
      pushError(issues, entryId, `${pathLabel} — identifiant reserve invalide`);
    }
    if (entry?.type !== 'menu' && entry?.type !== 'story' && entry?.type !== 'zip') {
      pushError(issues, entry?.id ?? null, `${pathLabel} — type d'element non pris en charge`);
      return;
    }

    if (entry?.type === 'menu') {
      const isSilentImportedContinuation = !!entry?.importedContinuation;
      if (!hasPath(entry?.audio) && !isSilentImportedContinuation) pushWarning(issues, entry?.id ?? null, `${pathLabel} — audio manquant`);
      else if (isBrokenPath(entry?.audio, fileAudit)) pushWarning(issues, entry?.id ?? null, `${pathLabel} — audio introuvable ou inaccessible`);
      if (!hasPath(entry?.image) && !entry?.autoBlackImage) {
        pushWarning(issues, entry?.id ?? null, `${pathLabel} — image manquante`);
      } else if (isBrokenPath(entry?.image, fileAudit)) {
        pushWarning(issues, entry?.id ?? null, `${pathLabel} — image introuvable ou inaccessible`);
      }
      if (getPlayableDescendantCount(projectIndex, entry.id) === 0) {
        pushWarning(issues, entry?.id ?? null, `${pathLabel} — collection vide`);
      }
      const menuReturnTarget = resolveNavigationMenuTarget(entry?.returnAfterPlay, entry?.id ?? null);
      if (hasPath(entry?.returnAfterPlay) && menuReturnTarget !== 'root' && menuReturnTarget && !menuIds.has(menuReturnTarget)) {
        pushError(issues, entry?.id ?? null, `${entryLabel} — destination de retour introuvable`);
      } else if (hasPath(entry?.returnAfterPlay) && menuReturnTarget && menuReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, menuReturnTarget) === 0) {
        pushError(issues, entry?.id ?? null, `${entryLabel} — destination de retour vide ou non jouable`);
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
      pushError(issues, entry?.id ?? null, `${entryLabel} — destination de retour introuvable`);
    } else if (hasPath(entry?.returnAfterPlay) && storyReturnTarget && storyReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, storyReturnTarget) === 0) {
      pushError(issues, entry?.id ?? null, `${entryLabel} — destination de retour vide ou non jouable`);
    }

    const homeReturnTarget = resolveNavigationMenuTarget(entry?.returnOnHome, storyReturnTarget);
    if (hasPath(entry?.returnOnHome) && homeReturnTarget !== 'root' && homeReturnTarget && !menuIds.has(homeReturnTarget)) {
      pushError(issues, entry?.id ?? null, `${entryLabel} — destination bouton Accueil introuvable`);
    } else if (hasPath(entry?.returnOnHome) && homeReturnTarget && homeReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, homeReturnTarget) === 0) {
      pushError(issues, entry?.id ?? null, `${entryLabel} — destination bouton Accueil vide ou non jouable`);
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
    pushWarning(issues, 'root', 'Le pack ne contient aucune histoire.');
  }
  return issues;
}

export function getGenerateErrors(project, fileAudit = {}) {
  return getProjectValidationIssues(project, fileAudit)
    .filter((issue) => issue.status === 'error' || issue.status === 'warning')
    .map((issue) => issue.text);
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
    if (hasPath(project?.thumbnailImage) && !isAccessiblePath(project?.thumbnailImage, fileAudit)) return 'error';
    let story = null;
    visitProjectEntries(project, (entry) => {
      if (!story && entry?.type === 'story') story = entry;
    });
    return isAccessiblePath(story?.audio, fileAudit) ? 'ok' : 'error';
  }

  return 'ok';
}
