import { useMemo, useRef } from 'react';
import { computeBadgesData, formatBadgeTitle } from '../tree/treeNavigationBadges';
import {
  getPresentedEndNodeHomeNavigation,
  getPresentedEndNodeReturnNavigation,
  getGeneratedNavigationTargetName,
  hasVisibleEndNode,
} from '../../store/generatedNavigation';
import { EMPTY_BADGES } from './treePanelConstants';

// Badges de navigation de l'arbre : calcul par entry (avec cache par référence)
// et badges du message de fin.
export function useTreeNavigationBadges({
  project,
  projectIndex,
  projectType,
  showNavigationBadges,
  validationIssues,
}) {
  const rootEntries = project.rootEntries ?? [];
  const issuesById = useMemo(() => {
    const map = new Map();
    for (const issue of validationIssues) {
      if (!issue?.id) continue;
      const list = map.get(issue.id) ?? [];
      list.push(issue);
      map.set(issue.id, list);
    }
    return map;
  }, [validationIssues]);

  // Cache navigation badges DATA (struct sans noms resolus). Survit aux
  // renders via useRef. Invalidation **par-entry-reference** : on ne re-calcule
  // les badges DATA que pour les entries dont la reference Zustand a change
  // (= elles ont ete mutees). Les autres reutilisent le cache.
  //
  // Trade-off assume :
  //   - Cas frequent (rename d'une story X, edit de ses media) : seule X est
  //     invalidee, les N-1 autres restent cached. **Gain principal.**
  //   - Cas marginal : si on ajoute une story juste apres Y et que Y retourne
  //     vers "next-story", le badge de Y pourrait theoriquement etre stale
  //     jusqu'a ce que Y soit re-touchee. En pratique, getGeneratedStoryNavigation
  //     n'utilise `rootEntries` que pour resoudre la cible `next-story` au
  //     niveau d'un menu, et cela n'apparait que dans le `targetId` resolu --
  //     dont la traduction en NOM se fait via formatBadgeTitle à chaque rendu
  //     (qui voit le projectIndex courant). Donc en pratique : ok.
  //
  // Les titres textuels sont reformates à chaque rendu via formatBadgeTitle,
  // donc tout rename de cible apparait immediatement dans l'UI meme si la DATA
  // n'est pas recalculee.
  const badgesDataCacheRef = useRef(new Map());
  const navigationBadgeProjectKey = [
    project?.nightModeAudio || '',
    project?.nightModeReturn || '',
    project?.globalOptions?.nightMode ? 'night' : '',
    project?.globalOptions?.endNode ? 'end' : '',
    project?.globalOptions?.autoNext ? 'auto' : '',
  ].join('|');

  const navigationBadgesById = useMemo(() => {
    const badgesById = new Map();
    if (projectType !== 'pack' || !showNavigationBadges) return badgesById;
    const cache = badgesDataCacheRef.current;
    const seenIds = new Set();

    for (const flatEntry of projectIndex.flatEntries) {
      const entry = flatEntry.entry;
      seenIds.add(entry.id);
      const parentMenuId = projectIndex.parentMenuById.get(entry.id);
      const parentMenu = parentMenuId ? (projectIndex.entryById.get(parentMenuId) ?? null) : null;
      const entryIssues = issuesById.get(entry.id);

      const cached = cache.get(entry.id);
      let data;
      if (cached
        && cached.entry === entry
        && cached.parentMenu === parentMenu
        && cached.issues === entryIssues
        && cached.rootEntries === rootEntries
        && cached.projectKey === navigationBadgeProjectKey
        && cached.showDefaultReturns === true) {
        data = cached.data;
      } else {
        data = computeBadgesData(entry, parentMenu, issuesById, project, rootEntries, {
          showDefaultReturns: true,
        });
        cache.set(entry.id, {
          entry,
          parentMenu,
          issues: entryIssues,
          rootEntries,
          projectKey: navigationBadgeProjectKey,
          showDefaultReturns: true,
          data,
        });
      }

      if (data.length > 0) {
        badgesById.set(entry.id, data.map((d) => formatBadgeTitle(d, projectIndex)).filter(Boolean));
      }
    }

    // Nettoyage des entries disparues du projet
    for (const id of cache.keys()) {
      if (!seenIds.has(id)) cache.delete(id);
    }

    return badgesById;
  }, [
    issuesById,
    project,
    projectIndex,
    projectType,
    navigationBadgeProjectKey,
    rootEntries,
    showNavigationBadges,
  ]);

  const hasEndNode = projectType === 'pack' && hasVisibleEndNode(project);

  const endNodeNavigationBadges = (() => {
    const badges = [];
    const returnNavigation = getPresentedEndNodeReturnNavigation(project);
    if (hasEndNode && returnNavigation) {
      const nightSuffix = project.globalOptions?.nightMode ? ' (mode nuit)' : '';
      const isNightMode = !!project.globalOptions?.nightMode;
      const returnName = returnNavigation.targetId
        ? getGeneratedNavigationTargetName(returnNavigation.targetId, projectIndex)
        : "destination de fin de l'histoire source";
      badges.push({
        key: `end-node-return:${returnNavigation.targetId || 'contextual'}:${returnName}`,
        kind: isNightMode ? 'end-night' : 'end-node',
        label: isNightMode ? '☾' : '■',
        title: `À la fin du message de fin${nightSuffix} → « ${returnName} »`,
      });
    }

    const homeNavigation = getPresentedEndNodeHomeNavigation(project);
    if (hasEndNode && homeNavigation?.targetId) {
      const homeName = getGeneratedNavigationTargetName(homeNavigation.targetId, projectIndex);
      const nightSuffix = homeNavigation.isNightMode ? ' (mode nuit)' : '';
      badges.push({
        key: `end-node-home:${homeNavigation.targetId}:${homeName}`,
        kind: homeNavigation.isNightMode ? 'end-night-home' : 'end-node-home',
        label: '⌂',
        title: `Appuie sur le bouton Accueil du message de fin${nightSuffix} → « ${homeName} »`,
      });
    }

    return badges.length ? badges : EMPTY_BADGES;
  })();

  return { navigationBadgesById, endNodeNavigationBadges, hasEndNode };
}
