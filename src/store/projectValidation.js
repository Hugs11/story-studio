// Validation projet cote frontend.
//
// Contrat partage avec Rust : src-tauri/src/domain/validation.rs#validate_project_for_generation.
// Les regles "structurelles" doivent rester miroirs ; le test de parite
// scripts/validationParity.test.mjs + le module #[cfg(test)] de validation.rs ancrent
// 4 cas canoniques (pack valide, story sans audio, pack vide, simple sans audio racine).
//
// Regles partagees JS <-> Rust (toute divergence est un bug a corriger):
//   - Audio racine obligatoire (rootAudio).
//   - Image racine / vignette obligatoires sur pack.
//   - Story : audio obligatoire, accessibilite disque verifiee.
//   - Story : itemImage + itemAudio obligatoires.
//   - Zip : zipPath obligatoire et fichier accessible.
//   - Pack non-vide : au moins une histoire jouable.
//
// Regles UX uniquement (cote JS, signalees a l'utilisateur en temps reel) :
//   - "duplicateId" : doublons d'ID dans rootEntries. Rust ne controle pas
//     (la generation cree des ids assainis distincts).
//   - "rootReservedId" : ID 'root' reserve. Rust applique implicitement.
//   - Cibles de navigation cassees (returnAfterPlay, etc.) : warning JS,
//     Rust accepte mais l'execution peut etre incoherente (cas couvert par
//     le test round-trip native_pack/tests/roundtrip.rs).
//   - emptyMenu / emptyPack : warnings JS, Rust refuse via "aucune histoire".
//
// Si une regle est ajoutee : l'implementer des deux cotes, etendre
// validation-projects.json + le module tests::parity_* de Rust.
//
// Taxonomie UI actuelle :
//   - aucune issue bloquante/warning -> "Pack prêt" ;
//   - status "error" ou "warning" -> "À corriger".
// Les deux statuts empechent aujourd'hui la generation cote React
// (voir App.jsx/canGenerate et getGenerateErrors). La distinction interne
// reste utile pour diagnostiquer les erreurs structurelles, mais elle n'est
// pas exposee comme deux categories dans l'UI parent.

import { buildProjectIndex, getPlayableDescendantCount, visitProjectEntries } from './projectModel.js';
import { decodeNavigationMenuId, decodeNavigationStoryId, isCurrentMenuNavigationTarget, isNextStoryNavigationTarget, isRootNavigationTarget, isStoryHomeStepNavigationTarget, isStoryNavigationTarget, normalizeNavigationTarget } from './navigationTargets.js';
import { VALIDATION_MESSAGES, brokenField, emptyTarget, missingField, missingTarget } from './validationMessages.js';

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
      pushError(issues, id, missingTarget(label, 'histoire'));
    } else if (isStoryHomeStepNavigationTarget(normalized) && !entry.afterPlaybackHomeStep) {
      pushError(issues, id, VALIDATION_MESSAGES.storyReturnLost(label));
    }
    return;
  }
  const menuId = decodeNavigationMenuId(normalized);
  if (!menuId || !menuIds.has(menuId)) {
    pushError(issues, id, missingTarget(label, 'dossier'));
  } else if (getPlayableDescendantCount(projectIndex, menuId) === 0) {
    pushError(issues, id, emptyTarget(label, 'dossier'));
  }
}

function validateStorySelectionItem(issues, item, fallbackName, fileAudit) {
  const name = labelOrFallback(item?.name, fallbackName);
  const itemId = item?.id ?? null;
  if (!hasPath(item?.audio)) pushWarning(issues, itemId, missingField(name, 'histoire', { feminine: true }));
  else if (isBrokenPath(item?.audio, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'histoire'));
  if (!hasPath(item?.itemImage)) pushWarning(issues, itemId, missingField(name, 'image', { feminine: true }));
  else if (isBrokenPath(item?.itemImage, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'image'));
  if (!hasPath(item?.itemAudio)) pushWarning(issues, itemId, missingField(name, 'audio titre'));
  else if (isBrokenPath(item?.itemAudio, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'audio titre'));
  if (hasPath(item?.afterPlaybackPromptAudio) && isBrokenPath(item?.afterPlaybackPromptAudio, fileAudit)) {
    pushWarning(issues, itemId, brokenField(name, "audio de fin d'histoire"));
  }
  for (const [index, step] of (item?.afterPlaybackSequence ?? []).entries()) {
    if (!hasPath(step?.audio)) {
      pushWarning(issues, itemId, missingField(name, `audio de fin ${index + 1}`));
    } else if (isBrokenPath(step.audio, fileAudit)) {
      pushWarning(issues, itemId, brokenField(name, `audio de fin ${index + 1}`));
    }
  }
}

function validateZipItem(issues, item, fallbackName, fileAudit) {
  const name = labelOrFallback(item?.name, fallbackName);
  if (!hasPath(item?.zipPath)) pushWarning(issues, item?.id ?? null, missingField(name, 'zip'));
  else if (isBrokenPath(item?.zipPath, fileAudit)) pushWarning(issues, item?.id ?? null, brokenField(name, 'zip'));
}

export function getProjectValidationIssues(project, fileAudit = {}, providedProjectIndex = null) {
  const issues = [];
  const projectType = project?.projectType;
  const rootName = labelOrFallback(project?.projectName || project?.packMetadata?.title, 'Nom de mon histoire');
  const autoNext = !!project?.globalOptions?.autoNext;
  const nightMode = !!project?.globalOptions?.nightMode;
  const hasEndNode = !autoNext && (nightMode || !!project?.nightModeAudio || !!project?.globalOptions?.endNode);
  const projectIndex = providedProjectIndex ?? buildProjectIndex(project);
  const { entryIdCounts, menuMap, firstSimpleStory, rootPlayableCount } = collectProjectGraphStats(projectIndex);
  const menuIds = new Set(menuMap.keys());

  if (!projectType) {
    pushWarning(issues, 'root', VALIDATION_MESSAGES.noProjectType);
    return issues;
  }

  for (const warning of project?.importWarnings ?? []) {
    pushWarning(
      issues,
      warning?.entryId ?? 'root',
      warning?.message || VALIDATION_MESSAGES.importedTransitionUnmodeled,
    );
  }

  for (const [entryId, count] of entryIdCounts.entries()) {
    if (count > 1) {
      pushError(issues, entryId, VALIDATION_MESSAGES.duplicateId(count, entryId));
    }
  }
  if (entryIdCounts.has('root')) {
    pushError(issues, 'root', VALIDATION_MESSAGES.rootReservedId);
  }

  if (!hasPath(project?.rootAudio)) pushWarning(issues, 'root', missingField('Menu racine', 'audio intro'));
  else if (isBrokenPath(project?.rootAudio, fileAudit)) pushWarning(issues, 'root', brokenField('Menu racine', 'audio intro'));
  if (!hasPath(project?.rootImage)) pushWarning(issues, 'root', missingField('Menu racine', 'image de couverture', { feminine: true }));
  else if (isBrokenPath(project?.rootImage, fileAudit)) pushWarning(issues, 'root', brokenField('Menu racine', 'image de couverture'));
  if (projectType === 'pack') {
    if (!hasPath(project?.thumbnailImage)) {
      pushWarning(
        issues,
        'root',
        `${missingField('Menu racine', 'image bibliothèque', { feminine: true })} (cocher « même image » ou en choisir une)`,
      );
    } else if (isBrokenPath(project?.thumbnailImage, fileAudit)) {
      pushWarning(issues, 'root', brokenField('Menu racine', 'image bibliothèque'));
    }
  } else if (hasPath(project?.thumbnailImage) && isBrokenPath(project?.thumbnailImage, fileAudit)) {
    pushWarning(issues, 'root', brokenField('Menu racine', 'image bibliothèque'));
  }
  if (hasEndNode && !hasPath(project?.nightModeAudio)) {
    pushWarning(issues, 'end-node', missingField('Message de fin', 'audio'));
  } else if (hasEndNode && isBrokenPath(project?.nightModeAudio, fileAudit)) {
    pushWarning(issues, 'end-node', brokenField('Message de fin', 'audio'));
  }

  if (projectType === 'simple') {
    if (!hasPath(firstSimpleStory?.audio)) {
      pushWarning(issues, 'root', missingField(rootName, 'histoire', { feminine: true }));
    } else if (isBrokenPath(firstSimpleStory?.audio, fileAudit)) {
      pushWarning(issues, 'root', brokenField(rootName, 'histoire'));
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
      pushError(issues, null, VALIDATION_MESSAGES.missingInternalId(pathLabel));
    } else if (entryId === 'root') {
      pushError(issues, entryId, VALIDATION_MESSAGES.reservedIdInvalid(pathLabel));
    }
    if (entry?.type !== 'menu' && entry?.type !== 'story' && entry?.type !== 'zip') {
      pushError(issues, entry?.id ?? null, VALIDATION_MESSAGES.unsupportedEntryType(pathLabel));
      return;
    }

    if (entry?.type === 'menu') {
      const menuId = entry?.id ?? null;
      const isSilentImportedContinuation = !!entry?.importedContinuation;
      if (!hasPath(entry?.audio) && !isSilentImportedContinuation) pushWarning(issues, menuId, missingField(pathLabel, 'audio'));
      else if (isBrokenPath(entry?.audio, fileAudit)) pushWarning(issues, menuId, brokenField(pathLabel, 'audio'));
      if (!hasPath(entry?.image) && !entry?.autoBlackImage) {
        pushWarning(issues, menuId, missingField(pathLabel, 'image', { feminine: true }));
      } else if (isBrokenPath(entry?.image, fileAudit)) {
        pushWarning(issues, menuId, brokenField(pathLabel, 'image'));
      }
      if (getPlayableDescendantCount(projectIndex, entry.id) === 0) {
        pushWarning(issues, menuId, VALIDATION_MESSAGES.emptyMenu(pathLabel));
      }
      if (!autoNext) {
        const menuReturnTarget = resolveNavigationMenuTarget(entry?.returnAfterPlay, menuId);
        if (hasPath(entry?.returnAfterPlay) && menuReturnTarget !== 'root' && menuReturnTarget && !menuIds.has(menuReturnTarget)) {
          pushError(issues, menuId, missingTarget(entryLabel, 'de retour'));
        } else if (hasPath(entry?.returnAfterPlay) && menuReturnTarget && menuReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, menuReturnTarget) === 0) {
          pushError(issues, menuId, emptyTarget(entryLabel, 'de retour'));
        }
      }
      validateNavigationTarget(
        issues,
        menuId,
        `${entryLabel} — Accueil du dossier`,
        entry?.returnOnHome,
        projectIndex,
        menuIds,
      );
      return;
    }

    const storyReturnTarget = autoNext
      ? (parentMenu?.id ?? null)
      : resolveNavigationMenuTarget(entry?.returnAfterPlay, parentMenu?.id ?? null);
    if (!autoNext) {
      if (hasPath(entry?.returnAfterPlay) && storyReturnTarget !== 'root' && storyReturnTarget && !menuIds.has(storyReturnTarget)) {
        pushError(issues, entry?.id ?? null, missingTarget(entryLabel, 'de retour'));
      } else if (hasPath(entry?.returnAfterPlay) && storyReturnTarget && storyReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, storyReturnTarget) === 0) {
        pushError(issues, entry?.id ?? null, emptyTarget(entryLabel, 'de retour'));
      }
    }

    const homeReturnTarget = resolveNavigationMenuTarget(entry?.returnOnHome, storyReturnTarget);
    if (hasPath(entry?.returnOnHome) && homeReturnTarget !== 'root' && homeReturnTarget && !menuIds.has(homeReturnTarget)) {
      pushError(issues, entry?.id ?? null, missingTarget(entryLabel, 'bouton Accueil'));
    } else if (hasPath(entry?.returnOnHome) && homeReturnTarget && homeReturnTarget !== 'root' && getPlayableDescendantCount(projectIndex, homeReturnTarget) === 0) {
      pushError(issues, entry?.id ?? null, emptyTarget(entryLabel, 'bouton Accueil'));
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
      if (!autoNext && hasPath(entry?.afterPlaybackPromptAudio)) {
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
      if (!autoNext && (entry?.afterPlaybackSequence ?? []).length > 0) {
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
    pushWarning(issues, 'root', VALIDATION_MESSAGES.emptyPack);
  }
  return issues;
}

export function getGenerateErrors(project, fileAudit = {}) {
  return getProjectValidationIssues(project, fileAudit)
    .filter((issue) => issue.status === 'error' || issue.status === 'warning')
    .map((issue) => issue.text);
}
