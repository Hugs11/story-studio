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
//      `targetId` en noms via projectIndex. A refaire a chaque render quand
//      projectIndex change (rapide : un seul Map.get).
//
// Pourquoi cette separation : sans elle, un rename d'une cible distante
// invalidait le badge de TOUTES les stories (puisque `title` contenait le
// nom resolu). Avec separation, la data est stable, seule la presentation
// se reactualise.

import {
  getGeneratedStoryNavigation,
  getGeneratedNavigationTargetName,
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

function returnStatusFromIssues(entryIssues) {
  return getStrongestStatus(entryIssues.filter((issue) => issue.text.includes('destination de retour')));
}

function homeStatusFromIssues(entryIssues) {
  return getStrongestStatus(entryIssues.filter((issue) => issue.text.includes('destination bouton Accueil') || issue.text.includes('destination Home spécifique inutile')));
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

// Etape 1 : structure des badges (kind, status, targetId pour les badges
// qui reference une autre entry). Ne resout PAS les noms.
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

  if (navigation.endNodeReturn.isActive) {
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
  } else if (navigation.hasSequence) {
    const targetId = sequenceReturnTarget(entry, parentMenu, rootEntries, navigation.directReturn.targetId);
    const isDefault = !(entry.afterPlaybackSequence ?? []).at(-1)?.okTarget;
    if (shouldShowDefault(isDefault)) {
      pushTargetBadge(out, {
        kind: 'return',
        status: statusWithDefault(returnStatus, isDefault),
        targetId,
        isDefault,
        flow: 'sequence',
      });
    }
  } else if (navigation.hasPrompt) {
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

// Etape 2 : transforme un BadgeData en Badge UI consumable par TreeNode.
// Resout les noms via projectIndex (lookup Map).
export function formatBadgeTitle(data, projectIndex) {
  switch (data.kind) {
    case 'graph':
      return {
        key: 'native-graph',
        kind: 'graph',
        label: '◇',
        title: 'Graphe interactif natif préservé pour le round-trip.',
      };
    case 'continuation':
      return {
        key: 'continuation',
        kind: 'continuation',
        label: '⇒',
        title: `Continuation native importée depuis ${data.sourceStoryName || 'une histoire'}.`,
      };
    case 'return': {
      const returnName = getGeneratedNavigationTargetName(data.targetId, projectIndex);
      const flow = data.flow === 'sequence'
        ? "À la fin de l'histoire : passage par le scénario de fin"
        : "À la fin de l'histoire";
      return {
        key: `return:${data.targetId}:${returnName}`,
        kind: 'return',
        status: data.status,
        label: '↩',
        title: `${flow} → « ${returnName} »`,
      };
    }
    case 'prompt-return': {
      const returnName = getGeneratedNavigationTargetName(data.targetId, projectIndex);
      const suffix = data.isInactive ? ', mais OK et autoplay sont désactivés sur le message de fin' : '';
      return {
        key: `prompt-return:${data.targetId}:${returnName}`,
        kind: 'prompt-return',
        status: data.status,
        label: '↩',
        title: `À la fin de l'histoire : passage par le message de fin personnalisé → « ${returnName} »${suffix}`,
      };
    }
    case 'home-none':
      return {
        key: 'home:none',
        kind: 'home-none',
        status: data.status,
        label: '⌂',
        title: 'Bouton Accueil désactivé pendant la lecture',
      };
    case 'home-implicit': {
      const homeName = getGeneratedNavigationTargetName(data.targetId, projectIndex);
      return {
        key: `home:implicit:${data.targetId}:${homeName}`,
        kind: 'home-implicit',
        status: data.status,
        label: '⌂',
        title: `Appuie sur le bouton Accueil pendant la lecture → « ${homeName} »`,
      };
    }
    case 'home': {
      const homeName = getGeneratedNavigationTargetName(data.targetId, projectIndex);
      return {
        key: `home:${data.targetId}:${homeName}`,
        kind: 'home',
        status: data.status,
        label: '⌂',
        title: data.isInactive
          ? `Appuie sur le bouton Accueil pendant la lecture → « ${homeName} », mais le bouton Accueil est désactivé pendant la lecture`
          : `Appuie sur le bouton Accueil pendant la lecture → « ${homeName} »`,
      };
    }
    case 'end-node':
    case 'end-night': {
      const returnName = getGeneratedNavigationTargetName(data.targetId, projectIndex);
      const suffix = data.kind === 'end-night' ? ' (mode nuit)' : '';
      return {
        key: `${data.kind}:${data.targetId}:${returnName}`,
        kind: data.kind,
        status: data.status,
        label: data.kind === 'end-night' ? '☾' : '■',
        title: `À la fin de l'histoire : passage par le message de fin${suffix} → « ${returnName} »`,
      };
    }
    default:
      return null;
  }
}
