import { translateTree as t, presentTreeNavigationTargetName } from '../../i18n/treePresentation.js';
// Badges de navigation affiches dans le TreePanel (retour/Home modifies ou
// par defaut, continuations importees, graphe natif preserve).
//
// Le calcul est en deux etapes pour separer DATA (structure du badge) et
// PRESENTATION (textes resolus avec les noms de cibles) :
//
//   1. computeBadgesData(entry, parentMenu, issuesById, project, rootEntries)
//      -> BadgeData[] sans noms textuels. Cacheable par-entry-reference :
//      pour une entry et son parent inchanges, la structure ne change pas.
//
//   2. formatBadgeTitle(data, projectIndex)
//      -> Badge UI prêt a afficher (key, label, title, status). Resout les
//      `targetId` en noms via projectIndex. À refaire à chaque rendu quand
//      projectIndex change (rapide : un seul Map.get).
//
// Pourquoi cette separation : sans elle, un rename d'une cible distante
// invalidait le badge de TOUTES les stories (puisque `title` contenait le
// nom resolu). Avec separation, la data est stable, seule la presentation
// se reactualise.

import {
  getGeneratedStoryNavigation,
  resolveGeneratedTargetForStory,
} from '../../store/generatedNavigation.js';

// Retourne 'error' / 'warn' / null selon la pile d'issues d'une entree.
export function getStrongestStatus(issues = []) {
  if (issues.some((issue) => issue.status === 'error')) return 'error';
  if (issues.some((issue) => issue.status === 'warn' || issue.status === 'warning')) return 'warn';
  return null;
}

function statusWithDefault(status, isDefault) {
  return status ?? (isDefault ? 'default' : null);
}

// Classement par identifiant stable posé par la validation (`issue.navigation`),
// jamais par le texte : il suit la langue de l'interface.
function returnStatusFromIssues(entryIssues) {
  return getStrongestStatus(entryIssues.filter((issue) => issue.navigation === 'return'));
}

function homeStatusFromIssues(entryIssues) {
  return getStrongestStatus(entryIssues.filter((issue) => issue.navigation === 'home'));
}

function sequenceReturnTarget(entry, parentMenu, rootEntries, fallbackTarget) {
  const sequence = entry?.afterPlaybackSequence ?? [];
  if (sequence.length === 0) return fallbackTarget;
  const lastStep = sequence[sequence.length - 1];
  return resolveGeneratedTargetForStory(
    lastStep?.okTarget,
    entry,
    parentMenu,
    rootEntries,
    fallbackTarget,
  );
}

function hasAutoNextMenuReturn(entry, parentMenu, project) {
  return !!(
    project?.globalOptions?.autoNext
    && parentMenu
  );
}

function defaultStoryHomeTarget(entry, parentMenu, project, navigation) {
  // Miroir de native_pack/builder/menu_branch.rs : dans un menu, quand OK avance
  // explicitement ou par auto-next, Home reste sur le menu pour conserver une
  // vraie sortie utilisateur.
  if (parentMenu && (entry?.returnAfterPlay || hasAutoNextMenuReturn(entry, parentMenu, project))) {
    return parentMenu.id;
  }
  return navigation.directReturn.targetId;
}

function pushTargetBadge(out, badge) {
  if (!badge.targetId) return;
  out.push(badge);
}

// Structure des badges (kind, status, targetId pour les badges qui référencent
// une autre entrée). Ne résout PAS les noms.
export function computeBadgesData(entry, parentMenu, issuesById, project, rootEntries, options = {}) {
  const showDefaultReturns = !!options.showDefaultReturns;
  if (entry?.type === 'menu' && entry.nativeGraph?.preserveForRoundTrip === true) {
    return [{ kind: 'graph' }];
  }
  if (entry?.type === 'menu' && entry.importedContinuation) {
    return [{
      kind: 'continuation',
      sourceStoryName: entry.importedContinuation.sourceStoryName || null,
    }];
  }
  if (entry?.type !== 'story') return [];

  const navigation = getGeneratedStoryNavigation(entry, parentMenu, project, rootEntries);
  const out = [];

  const entryIssues = issuesById.get(entry.id) ?? [];
  const homeStatus = homeStatusFromIssues(entryIssues);
  const returnStatus = returnStatusFromIssues(entryIssues);
  const shouldShowDefault = (isDefault) => !isDefault || showDefaultReturns;

  if (navigation.endNodeReturn.isPresented) {
    const isDefault = !navigation.endNodeReturn.isConfigured;
    if (shouldShowDefault(isDefault)) {
      pushTargetBadge(out, {
        kind: navigation.endNodeReturn.isNightMode ? 'end-night' : 'end-node',
        status: statusWithDefault(null, isDefault),
        targetId: navigation.endNodeReturn.effectiveTargetId ?? navigation.endNodeReturn.targetId,
        isDefault,
        isImportedPrompt: navigation.endNodeReturn.isImportedPrompt,
      });
    }
  } else if (navigation.endMessage.presentationKind === 'local_sequence') {
    const targetId = sequenceReturnTarget(entry, parentMenu, rootEntries, navigation.directReturn.targetId);
    const isDefault = !(entry.afterPlaybackSequence ?? []).at(-1)?.okTarget;
    if (shouldShowDefault(isDefault)) {
      pushTargetBadge(out, {
        kind: 'sequence-return',
        status: statusWithDefault(returnStatus, isDefault),
        targetId,
        isDefault,
      });
    }
  } else if (navigation.endMessage.presentationKind === 'local_prompt') {
    const isDefault = !navigation.promptReturn.isConfigured;
    if (shouldShowDefault(isDefault)) {
      pushTargetBadge(out, {
        kind: 'prompt-return',
        status: statusWithDefault(navigation.promptReturn.isInactive ? 'warn' : returnStatus, isDefault),
        targetId: navigation.promptReturn.targetId ?? navigation.directReturn.targetId,
        isDefault,
        isInactive: navigation.promptReturn.isInactive,
      });
    }
  } else {
    const isDefault = !navigation.directReturn.isModified;
    if (shouldShowDefault(isDefault)) {
      pushTargetBadge(out, {
        kind: 'return',
        status: statusWithDefault(returnStatus, isDefault),
        targetId: navigation.directReturn.targetId,
        isDefault,
      });
    }
  }

  if (navigation.storyHome.isInactive) {
    out.push({
      kind: 'home-none',
      status: homeStatus,
      isDefault: false,
    });
  } else if (navigation.storyHome.isEndHomeStep) {
    // La réaction Accueil de fin remplace la destination Accueil réglée.
    out.push({
      kind: 'home',
      status: homeStatus,
      targetId: navigation.storyHome.effectiveTargetId,
      isEndHomeStep: true,
      isDefault: false,
    });
  } else if (navigation.storyHome.isImplicit) {
    out.push({
      kind: 'home-implicit',
      status: homeStatus,
      targetId: navigation.storyHome.effectiveTargetId,
      isDefault: false,
    });
  } else if (navigation.storyHome.isConfigured) {
    pushTargetBadge(out, {
      kind: 'home',
      status: navigation.storyHome.isInactive ? 'warn' : homeStatus,
      targetId: navigation.storyHome.targetId,
      isInactive: navigation.storyHome.isInactive,
      isDefault: false,
    });
  } else if (showDefaultReturns) {
    pushTargetBadge(out, {
      kind: 'home',
      status: statusWithDefault(navigation.storyHome.isInactive ? 'warn' : homeStatus, true),
      targetId: defaultStoryHomeTarget(entry, parentMenu, project, navigation),
      isInactive: navigation.storyHome.isInactive,
      isDefault: true,
    });
  }

  return out;
}

// Transforme un BadgeData en badge UI consommable par TreeNode.
// Résout les noms via projectIndex (lookup Map).
export function formatBadgeTitle(data, projectIndex) {
  switch (data.kind) {
    case 'graph':
      return {
        key: 'native-graph',
        kind: 'graph',
        label: '◇',
        title: t("tree:badge.graph.preserved"),
      };
    case 'continuation':
      return {
        key: 'continuation',
        kind: 'continuation',
        label: '⇒',
        title: t("tree:badge.continuation.source", { name: data.sourceStoryName || t('tree:badge.continuation.fallback') }),
      };
    case 'return': {
      const returnName = presentTreeNavigationTargetName(data.targetId, projectIndex);
      return {
        key: `return:${data.targetId}:${returnName}`,
        kind: 'return',
        status: data.status,
        label: '↩',
        title: t("tree:badge.story.return", { returnName }),
      };
    }
    case 'sequence-return': {
      const returnName = presentTreeNavigationTargetName(data.targetId, projectIndex);
      return {
        key: `sequence-return:${data.targetId}:${returnName}`,
        kind: 'sequence-return',
        status: data.status,
        label: '▤',
        title: t("tree:badge.sequence.return", { returnName }),
      };
    }
    case 'prompt-return': {
      const returnName = presentTreeNavigationTargetName(data.targetId, projectIndex);
      const suffix = data.isInactive ? t("tree:badge.prompt.inactiveSuffix") : '';
      return {
        key: `prompt-return:${data.targetId}:${returnName}`,
        kind: 'prompt-return',
        status: data.status,
        label: '↩',
        title: t("tree:badge.prompt.return", { returnName, suffix }),
      };
    }
    case 'home-none':
      return {
        key: 'home:none',
        kind: 'home-none',
        status: data.status,
        label: '⌂',
        title: t("tree:badge.home.disabled"),
      };
    case 'home-implicit': {
      if (!data.targetId) {
        // Accueil sans destination : la Lunii revient d'elle-même à l'Écran d'entrée.
        return {
          key: 'home:implicit:pack-start',
          kind: 'home-implicit',
          status: data.status,
          label: '⌂',
          title: t("tree:badge.home.default"),
        };
      }
      const homeName = presentTreeNavigationTargetName(data.targetId, projectIndex);
      return {
        key: `home:implicit:${data.targetId}:${homeName}`,
        kind: 'home-implicit',
        status: data.status,
        label: '⌂',
        title: t("tree:badge.home.target", { homeName }),
      };
    }
    case 'home': {
      if (data.isEndHomeStep) {
        // La réaction appartient à l'histoire qui porte la pastille.
        return {
          key: `home:${data.targetId}`,
          kind: 'home',
          status: data.status,
          label: '⌂',
          title: t("tree:badge.home.reaction"),
        };
      }
      const homeName = presentTreeNavigationTargetName(data.targetId, projectIndex);
      return {
        key: `home:${data.targetId}:${homeName}`,
        kind: 'home',
        status: data.status,
        label: '⌂',
        title: data.isInactive
          ? t("tree:badge.home.inactiveTarget", { homeName })
          : t("tree:badge.home.target", { homeName }),
      };
    }
    case 'end-node':
    case 'end-night': {
      const returnName = presentTreeNavigationTargetName(data.targetId, projectIndex);
      const suffix = data.kind === 'end-night' ? t('tree:badge.night.suffix') : '';
      return {
        key: `${data.kind}:${data.targetId}:${returnName}`,
        kind: data.kind,
        status: data.status,
        label: data.kind === 'end-night' ? '☾' : '■',
        title: t("tree:badge.globalEnd.return", { suffix, returnName }),
      };
    }
    default:
      return null;
  }
}
