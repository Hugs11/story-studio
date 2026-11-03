import { presentImportWarning } from '../i18n/importWarnings.js';
// Validation projet cote frontend.
//
// Contrat partage avec Rust : src-tauri/src/domain/validation.rs#validate_project_for_generation.
// Les regles "structurelles" doivent rester miroirs ; le test de parite
// scripts/validationParity.test.mjs + le module #[cfg(test)] de validation.rs ancrent
// 4 cas canoniques (pack valide, story sans audio, pack vide, simple sans audio racine).
//
// Regles partagees JS <-> Rust (toute divergence est un bug a corriger):
//   - Audio racine obligatoire (rootAudio).
//   - Image racine obligatoire ; sans vignette propre, le catalogue la reprend.
//   - Story : audio obligatoire, accessibilite disque verifiee.
//   - Story : itemImage obligatoire, itemAudio obligatoire sauf titre explicite silencieux.
//   - Zip : zipPath obligatoire et fichier accessible.
//   - Pack non-vide : au moins une histoire jouable.
//   - Cibles de navigation cassees (returnAfterPlay, returnOnHome, sequences,
//     destinations du message de fin global).
//   - Regles d'activite (native_pack/canonical.rs) : un champ que le reglage courant
//     rend inutile (fin locale sous Auto-next, image d'un Ecran transparent, message
//     de fin global qu'aucune histoire n'emprunte) n'est ni exige ni verifie.
//
// Regles UX uniquement (cote JS, signalees a l'utilisateur en temps reel) :
//   - "duplicateId" : doublons d'ID dans rootEntries. Rust ne controle pas
//     (la generation cree des ids assainis distincts).
//   - "rootReservedId" : ID 'root' reserve. Rust applique implicitement.
//   - emptyMenu / emptyPack : warnings JS, Rust refuse via "aucune histoire".
//   - "storyWithoutExit" : histoire dont l'écran de lecture n'a ni OK, ni lecture
//     automatique, ni Accueil. Rust refuse a la generation (native_pack/port_rules.rs) ;
//     seule cette forme est realisable depuis la fiche d'une histoire
//     (native_pack/tests/menu_endings.rs), les autres fins sont normalisees.
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
import { VALIDATION_MESSAGES as PRESENTED_MESSAGES, brokenField as presentBrokenField, emptyTarget as presentEmptyTarget, missingField as presentMissingField, missingTarget as presentMissingTarget, validationLabel } from './validationMessages.js';
import { isStorySelectionAudioRequired } from './storyTitleStage.js';
import { isEndHomeStepActive, isEndPromptActive, isEndSequenceActive, projectReachesEndNode } from './generatedNavigation.js';
import { getGeneratedStoryPlayControls } from './generatedPlayback.js';

// Le texte d'une issue est relu à chaque lecture (accesseur) : la liste déjà
// calculée suit un changement de langue sans recalcul du projet. Les codes,
// paramètres et statuts restent ceux de la validation.
const lazy = (present) => (...args) => () => present(...args);
const missingField = lazy(presentMissingField);
const brokenField = lazy(presentBrokenField);
const missingTarget = lazy(presentMissingTarget);
const emptyTarget = lazy(presentEmptyTarget);
const VALIDATION_MESSAGES = Object.freeze({
  get noProjectType() { return () => PRESENTED_MESSAGES.noProjectType; },
  get importedTransitionUnmodeled() { return () => PRESENTED_MESSAGES.importedTransitionUnmodeled; },
  get rootReservedId() { return () => PRESENTED_MESSAGES.rootReservedId; },
  get emptyPack() { return () => PRESENTED_MESSAGES.emptyPack; },
  missingInternalId: lazy(PRESENTED_MESSAGES.missingInternalId),
  unsupportedEntryType: lazy(PRESENTED_MESSAGES.unsupportedEntryType),
  reservedIdInvalid: lazy(PRESENTED_MESSAGES.reservedIdInvalid),
  duplicateId: lazy(PRESENTED_MESSAGES.duplicateId),
  storyReturnLost: lazy(PRESENTED_MESSAGES.storyReturnLost),
  storyWithoutExit: lazy(PRESENTED_MESSAGES.storyWithoutExit),
  emptyMenu: lazy(PRESENTED_MESSAGES.emptyMenu),
});

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBrokenPath(value, fileAudit = {}) {
  return hasPath(value) && fileAudit[value] === false;
}

function labelOrFallback(value, fallback) {
  return (value || '').trim() || fallback;
}

// status === 'error'   → vraie erreur structurelle (référence cassée, donnée corrompue)
// status === 'warning' → projet en construction (champ manquant, fichier introuvable, contenu vide)
// Les deux bloquent la génération ; seule la couleur d'affichage diffère.
// `navigation` ('return' | 'home') : identifiant stable de la destination
// vérifiée, lu par les badges de l'arbre au lieu du texte (qui suit la langue).
function pushIssue(issues, id, status, text, extra = null) {
  const issue = { id, status, ...extra };
  if (typeof text === 'function') Object.defineProperty(issue, 'text', { enumerable: true, configurable: true, get: text });
  else issue.text = text;
  issues.push(issue);
}

function pushError(issues, id, text, extra = null) {
  pushIssue(issues, id, 'error', text, extra);
}

function pushWarning(issues, id, text) {
  pushIssue(issues, id, 'warning', text);
}

function collectProjectGraphStats(projectIndex) {
  return {
    entryIdCounts: projectIndex.entryIdCounts,
    menuMap: new Map(projectIndex.menuEntries.map((entry) => [entry.id, entry])),
    firstSimpleStory: projectIndex.firstSimpleStory,
    rootPlayableCount: projectIndex.rootPlayableCount,
  };
}

// `navigation` : les dossiers existants et le projet, dont les réglages
// décident quelles réactions Accueil le constructeur construit.
function validateNavigationTarget(issues, id, label, target, projectIndex, navigation, navigationKind = null) {
  const extra = navigationKind ? { navigation: navigationKind } : null;
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return;
  if (isRootNavigationTarget(normalized) || isCurrentMenuNavigationTarget(normalized) || isNextStoryNavigationTarget(normalized)) {
    return;
  }
  if (isStoryNavigationTarget(normalized)) {
    const storyId = decodeNavigationStoryId(normalized);
    const entry = storyId ? projectIndex.entryById.get(storyId) : null;
    if (!entry || entry.type !== 'story') {
      pushError(issues, id, missingTarget(label, 'histoire'), extra);
    } else if (
      isStoryHomeStepNavigationTarget(normalized)
      && !(entry.afterPlaybackHomeStep && isEndHomeStepActive(entry, navigation.project))
    ) {
      // « Retour de fin » ne vise qu'une réaction que le constructeur construit.
      pushError(issues, id, VALIDATION_MESSAGES.storyReturnLost(label), extra);
    }
    return;
  }
  const menuId = decodeNavigationMenuId(normalized);
  if (!menuId || !navigation.menuIds.has(menuId)) {
    pushError(issues, id, missingTarget(label, 'dossier'), extra);
  } else if (getPlayableDescendantCount(projectIndex, menuId) === 0) {
    pushError(issues, id, emptyTarget(label, 'dossier'), extra);
  }
}

function validateStorySelectionItem(issues, item, fallbackName, fileAudit, project) {
  const name = labelOrFallback(item?.name, fallbackName);
  const itemId = item?.id ?? null;
  const selectionAudioRequired = isStorySelectionAudioRequired(item);
  if (!hasPath(item?.audio)) pushWarning(issues, itemId, missingField(name, 'histoire', { feminine: true }));
  else if (isBrokenPath(item?.audio, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'histoire'));
  if (!hasPath(item?.itemImage)) pushWarning(issues, itemId, missingField(name, 'image', { feminine: true }));
  else if (isBrokenPath(item?.itemImage, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'image'));
  if (!hasPath(item?.itemAudio) && selectionAudioRequired) pushWarning(issues, itemId, missingField(name, 'audio titre'));
  else if (isBrokenPath(item?.itemAudio, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'audio titre'));
  // Médias de fin : seuls ceux que le moteur écrit sont vérifiés (miroir des
  // règles d'activité Rust). Une étape ou une réaction sans média reste valide :
  // le moteur et les lecteurs acceptent un écran muet.
  if (isEndPromptActive(item, project) && isBrokenPath(item?.afterPlaybackPromptAudio, fileAudit)) {
    pushWarning(issues, itemId, brokenField(name, "audio de fin d'histoire"));
  }
  if (isEndSequenceActive(item, project)) {
    for (const [index, step] of item.afterPlaybackSequence.entries()) {
      if (isBrokenPath(step?.audio, fileAudit)) pushWarning(issues, itemId, brokenField(name, { code: 'VALIDATION_FIELD_ENDING_AUDIO_NUMBERED', params: { index: index + 1 } }));
      if (isBrokenPath(step?.image, fileAudit)) pushWarning(issues, itemId, brokenField(name, { code: 'VALIDATION_FIELD_ENDING_IMAGE_NUMBERED', params: { index: index + 1 } }));
    }
  }
  const homeStep = item?.afterPlaybackHomeStep;
  if (homeStep && isEndHomeStepActive(item, project)) {
    if (isBrokenPath(homeStep.audio, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'audio de la réaction Accueil'));
    if (isBrokenPath(homeStep.image, fileAudit)) pushWarning(issues, itemId, brokenField(name, 'image de la réaction Accueil'));
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
  const rootName = labelOrFallback(project?.projectName || project?.packMetadata?.title, validationLabel('LABEL_PROJECT_UNNAMED_PACK'));
  const autoNext = !!project?.globalOptions?.autoNext;
  const nightMode = !!project?.globalOptions?.nightMode;
  // Le message de fin global n'est vérifié que si une histoire l'emprunte : remplacé
  // partout par des fins locales, le moteur ne l'écrit pas.
  const hasEndNode = !autoNext
    && (nightMode || !!project?.nightModeAudio || !!project?.globalOptions?.endNode)
    && projectReachesEndNode(project);
  const projectIndex = providedProjectIndex ?? buildProjectIndex(project);
  const { entryIdCounts, menuMap, firstSimpleStory, rootPlayableCount } = collectProjectGraphStats(projectIndex);
  const navigation = { menuIds: new Set(menuMap.keys()), project };

  if (!projectType) {
    pushWarning(issues, 'root', VALIDATION_MESSAGES.noProjectType);
    return issues;
  }

  for (const warning of project?.importWarnings ?? []) {
    pushWarning(
      issues,
      warning?.entryId ?? 'root',
      warning?.message ? () => presentImportWarning(warning) : VALIDATION_MESSAGES.importedTransitionUnmodeled,
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

  if (!hasPath(project?.rootAudio)) pushWarning(issues, 'root', missingField(validationLabel('LABEL_PROJECT_ROOT_MENU'), 'audio intro'));
  else if (isBrokenPath(project?.rootAudio, fileAudit)) pushWarning(issues, 'root', brokenField(validationLabel('LABEL_PROJECT_ROOT_MENU'), 'audio intro'));
  if (!hasPath(project?.rootImage)) pushWarning(issues, 'root', missingField(validationLabel('LABEL_PROJECT_ROOT_MENU'), 'image de couverture', { feminine: true }));
  else if (isBrokenPath(project?.rootImage, fileAudit)) pushWarning(issues, 'root', brokenField(validationLabel('LABEL_PROJECT_ROOT_MENU'), 'image de couverture'));
  // Sans vignette propre, le catalogue reprend l'image racine : il ne manque
  // donc jamais de vignette. Une vignette propre se vérifie comme un média.
  if (!project?.sameImage && hasPath(project?.thumbnailImage) && isBrokenPath(project?.thumbnailImage, fileAudit)) {
    pushWarning(issues, 'root', brokenField(validationLabel('LABEL_PROJECT_PACK_CARD'), 'vignette catalogue'));
  }
  if (hasEndNode && !hasPath(project?.nightModeAudio)) {
    pushWarning(issues, 'end-node', missingField(validationLabel('LABEL_PROJECT_END_MESSAGE'), 'audio'));
  } else if (hasEndNode && isBrokenPath(project?.nightModeAudio, fileAudit)) {
    pushWarning(issues, 'end-node', brokenField(validationLabel('LABEL_PROJECT_END_MESSAGE'), 'audio'));
  }

  if (projectType === 'simple') {
    if (!hasPath(firstSimpleStory?.audio)) {
      pushWarning(issues, 'root', missingField(rootName, 'histoire', { feminine: true }));
    } else if (isBrokenPath(firstSimpleStory?.audio, fileAudit)) {
      pushWarning(issues, 'root', brokenField(rootName, 'histoire'));
    }
    return issues;
  }

  // Une destination du message de fin qui ne mène plus nulle part (histoire ou
  // dossier supprimé) reste visible et à corriger : le moteur la remplacerait
  // sans le dire par le retour propre à chaque histoire.
  if (hasEndNode) {
    validateNavigationTarget(issues, 'end-node', validationLabel('LABEL_PROJECT_END_AFTER'), project?.nightModeReturn, projectIndex, navigation);
    validateNavigationTarget(issues, 'end-node', validationLabel('LABEL_PROJECT_END_HOME'), project?.nightModeHomeReturn, projectIndex, navigation);
  }

  visitProjectEntries(project, (entry, ancestors) => {
    const entryLabel = labelOrFallback(entry?.name, entry?.type === 'menu' ? validationLabel('LABEL_PROJECT_COLLECTION') : validationLabel('LABEL_PROJECT_ELEMENT'));
    const pathLabel = { messages: [...ancestors.map((parent) => labelOrFallback(parent?.name, validationLabel('LABEL_PROJECT_COLLECTION'))), entryLabel], separator: ' / ', data: true };
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
      if (entry?.autoBlackImage) {
        // Écran transparent : le moteur n'écrit pas l'image éventuellement conservée.
      } else if (!hasPath(entry?.image)) {
        pushWarning(issues, menuId, missingField(pathLabel, 'image', { feminine: true }));
      } else if (isBrokenPath(entry?.image, fileAudit)) {
        pushWarning(issues, menuId, brokenField(pathLabel, 'image'));
      }
      if (getPlayableDescendantCount(projectIndex, entry.id) === 0) {
        pushWarning(issues, menuId, VALIDATION_MESSAGES.emptyMenu(pathLabel));
      }
      if (!autoNext && hasPath(entry?.returnAfterPlay)) {
        validateNavigationTarget(
          issues,
          menuId,
          validationLabel('LABEL_UI_STORIES_TARGET', { label: entryLabel }),
          entry?.returnAfterPlay,
          projectIndex,
          navigation,
          'return',
        );
      }
      validateNavigationTarget(
        issues,
        menuId,
        validationLabel('LABEL_UI_FOLDER_HOME', { label: entryLabel }),
        entry?.returnOnHome,
        projectIndex,
        navigation,
      );
      return;
    }

    if (!autoNext && hasPath(entry?.returnAfterPlay)) {
      validateNavigationTarget(
        issues,
        entry?.id ?? null,
        validationLabel('LABEL_UI_ENDING_TARGET', { label: entryLabel }),
        entry?.returnAfterPlay,
        projectIndex,
        navigation,
        'return',
      );
    }

    if (hasPath(entry?.returnOnHome)) {
      validateNavigationTarget(
        issues,
        entry?.id ?? null,
        validationLabel('LABEL_UI_HOME_BUTTON', { label: entryLabel }),
        entry?.returnOnHome,
        projectIndex,
        navigation,
        'home',
      );
    }

    if (!entry?.titleReturnOnHomeNone) {
      validateNavigationTarget(
        issues,
        entry?.id ?? null,
        validationLabel('LABEL_UI_TITLE_HOME', { label: entryLabel }),
        entry?.titleReturnOnHome,
        projectIndex,
        navigation,
      );
    }

    if (entry?.type === 'zip') validateZipItem(issues, entry, pathLabel, fileAudit);
    else {
      validateStorySelectionItem(issues, entry, pathLabel, fileAudit, project);
      // Les réglages que le générateur écrira réellement (lecture automatique
      // forcée comprise) : sans OK, lecture automatique ni Accueil, l'enfant
      // reste bloqué à la fin de l'histoire. Une étape de fin active donne une
      // destination OK à l'écran de lecture, et le générateur y rallume OK.
      const parentMenu = ancestors.at(-1)?.type === 'menu' ? ancestors.at(-1) : null;
      const playControls = getGeneratedStoryPlayControls(entry, parentMenu, project);
      const hasEndStep = isEndSequenceActive(entry, project)
        || (isEndPromptActive(entry, project) && hasPath(entry?.afterPlaybackPromptAudio));
      if (!hasEndStep && !playControls.ok && !playControls.autoplay && !playControls.home) {
        pushError(issues, entry?.id ?? null, VALIDATION_MESSAGES.storyWithoutExit(pathLabel));
      }
      if (isEndPromptActive(entry, project) && hasPath(entry?.afterPlaybackPromptAudio)) {
        validateNavigationTarget(
          issues,
          entry?.id ?? null,
          validationLabel('LABEL_UI_PROMPT_OK', { label: entryLabel }),
          entry?.afterPlaybackPromptOkTarget,
          projectIndex,
          navigation,
        );
        if (!entry?.afterPlaybackPromptHomeNone) {
          validateNavigationTarget(
            issues,
            entry?.id ?? null,
            validationLabel('LABEL_UI_PROMPT_HOME', { label: entryLabel }),
            entry?.afterPlaybackPromptHomeTarget,
            projectIndex,
            navigation,
          );
        }
      }
      if (isEndSequenceActive(entry, project)) {
        for (const [index, step] of entry.afterPlaybackSequence.entries()) {
          validateNavigationTarget(
            issues,
            entry?.id ?? null,
            validationLabel('LABEL_UI_ENDING_OK', { label: entryLabel, index: index + 1 }),
            step?.okTarget,
            projectIndex,
            navigation,
          );
          for (const target of step?.okChoiceTargets ?? []) {
            validateNavigationTarget(
              issues,
              entry?.id ?? null,
              validationLabel('LABEL_UI_ENDING_OK', { label: entryLabel, index: index + 1 }),
              target,
              projectIndex,
              navigation,
            );
          }
          if (!step?.homeFollowsOk && !step?.homeNone) {
            validateNavigationTarget(
              issues,
              entry?.id ?? null,
              validationLabel('LABEL_UI_ENDING_HOME', { label: entryLabel, index: index + 1 }),
              step?.homeTarget,
              projectIndex,
              navigation,
            );
          }
        }
      }
      // Réaction au bouton Accueil : mêmes règles d'activité que ses médias
      // (miroir de `validation.rs`, « retour Home de fin »).
      const homeStep = entry?.afterPlaybackHomeStep;
      if (homeStep && isEndHomeStepActive(entry, project)) {
        for (const target of [homeStep.okTarget, ...(homeStep.okChoiceTargets ?? [])]) {
          validateNavigationTarget(
            issues,
            entry?.id ?? null,
            validationLabel('LABEL_UI_REACTION_OK', { label: entryLabel }),
            target,
            projectIndex,
            navigation,
          );
        }
        if (!homeStep.homeFollowsOk && !homeStep.homeNone) {
          validateNavigationTarget(
            issues,
            entry?.id ?? null,
            validationLabel('LABEL_UI_REACTION_HOME', { label: entryLabel }),
            homeStep.homeTarget,
            projectIndex,
            navigation,
          );
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
