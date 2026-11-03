import { presentProduction } from './productionPresentation.js';
import { decodeNavigationStoryId, isStoryNavigationTarget, isStoryHomeStepNavigationTarget, isStoryPlayNavigationTarget } from '../store/navigationTargets.js';
import i18next, { createInstance } from 'i18next';
import frTree from '../locales/fr/tree.json' with { type: 'json' };
import frCommon from '../locales/fr/common.json' with { type: 'json' };

// Les fonctions pures peuvent précéder le Provider ; résoudre uniquement à l'affichage.
const source = createInstance();
source.init({ lng: 'fr', defaultNS: 'tree', keySeparator: false, initAsync: false,
  resources: { fr: { tree: frTree, common: frCommon } }, interpolation: { escapeValue: false } });
export function translateTree(key, params) {
  if (params) params = Object.fromEntries(Object.entries(params).map(([name, value]) => [name, presentTree(value)]));
  return i18next.isInitialized && i18next.hasResourceBundle(i18next.resolvedLanguage ?? 'fr', 'tree')
    ? i18next.t(key, params) : source.t(key, params);
}
export function presentTree(value) {
  if (value?.key?.startsWith('production:')) return presentProduction(value);
  if (Array.isArray(value)) return value.map(presentTree).join(' · ');
  return value?.key?.startsWith('tree:') ? translateTree(value.key, Object.fromEntries(
    Object.entries(value.params ?? {}).map(([key, param]) => [key, presentTree(param)]),
  )) : value;
}

// Libellés des destinations : présentation uniquement, les identifiants restent intacts.
export function presentTreeNavigationTargetName(targetId, projectIndex, fallback = translateTree('tree:navigation.destination.missing')) {
  if (targetId === 'root') return translateTree('tree:navigation.root.short');
  if (targetId === 'next_story') return translateTree('tree:navigation.nextStory.label');
  if (targetId === '__contextual_next_story__') return translateTree('tree:navigation.nextStory.context');
  if (!targetId) return fallback;
  if (isStoryNavigationTarget(targetId)) {
    const name = projectIndex?.entryById?.get(decodeNavigationStoryId(targetId))?.name || fallback;
    if (isStoryHomeStepNavigationTarget(targetId)) return translateTree('tree:navigation.story.endReturn', { name });
    if (isStoryPlayNavigationTarget(targetId)) return translateTree('tree:navigation.story.direct', { name });
    return name;
  }
  return projectIndex?.entryById?.get(targetId)?.name || fallback;
}
