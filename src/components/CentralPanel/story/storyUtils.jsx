import {
  NAV_TARGET_NEXT_STORY,
  decodeNavigationMenuId,
  decodeNavigationStoryId,
  encodeMenuNavigationTarget,
  encodeStoryHomeStepNavigationTarget,
  encodeStoryNavigationTarget,
  encodeStoryPlayNavigationTarget,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryHomeStepNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
  normalizeNavigationTarget,
} from '../../../store/navigationTargets';

export { NAV_TARGET_NEXT_STORY };

export const CONTROL_DEFS = [
  { key: 'autoplay', label: 'Lecture automatique', def: true },
  { key: 'ok',       label: 'Bouton OK',            def: true },
  { key: 'home',     label: 'Bouton Accueil',        def: true },
  { key: 'pause',    label: 'Bouton pause',          def: false },
  { key: 'wheel',    label: 'Molette',               def: false },
];

export const SEQUENCE_CONTROL_DEFAULTS = {
  autoplay: true,
  ok: false,
  home: true,
  pause: false,
  wheel: false,
};

export function normalizeSequenceStep(step = {}, index = 0) {
  const controls = step.controlSettings ?? {};
  return {
    id: step.id || crypto.randomUUID(),
    name: step.name || `Étape ${index + 1}`,
    audio: step.audio ?? null,
    image: step.image ?? null,
    controlSettings: { ...SEQUENCE_CONTROL_DEFAULTS, ...controls },
    okTarget: normalizeNavigationTarget(step.okTarget),
    okChoiceTargets: Array.isArray(step.okChoiceTargets)
      ? step.okChoiceTargets.map(normalizeNavigationTarget).filter(Boolean)
      : [],
    homeTarget: normalizeNavigationTarget(step.homeTarget),
    homeFollowsOk: !!step.homeFollowsOk,
    homeNone: !!step.homeNone,
  };
}

export function resolveNavigationTargetId(target, currentMenuId = null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return null;
  if (isRootNavigationTarget(normalized)) return 'root';
  if (isCurrentMenuNavigationTarget(normalized)) return currentMenuId ?? null;
  if (isNextStoryNavigationTarget(normalized)) return NAV_TARGET_NEXT_STORY;
  if (isStoryNavigationTarget(normalized)) return normalized;
  return decodeNavigationMenuId(normalized);
}

export function targetNameById(allMenus, allStories, targetId, fallback = 'destination introuvable') {
  if (targetId === 'root') return 'Début du pack';
  if (targetId === NAV_TARGET_NEXT_STORY) return 'Histoire suivante';
  if (!targetId) return fallback;
  if (isStoryNavigationTarget(targetId)) {
    const storyId = decodeNavigationStoryId(targetId);
    const storyName = allStories.find((s) => s.id === storyId)?.name || fallback;
    return isStoryHomeStepNavigationTarget(targetId)
      ? `Retour de fin — ${storyName}`
      : isStoryPlayNavigationTarget(targetId)
      ? `Lecture directe — ${storyName}`
      : `Titre — ${storyName}`;
  }
  return allMenus.find((menu) => menu.id === targetId)?.name || fallback;
}

export function NavigationTargetSelect({
  value,
  onChange,
  allMenus,
  allStories,
  currentStoryId,
  includeNone = false,
  noneLabel = 'Aucune transition',
  emptyLabel = 'Destination par défaut',
  style,
}) {
  return (
    <select
      className="field-input"
      style={style}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{emptyLabel}</option>
      {includeNone ? <option value="__none__">{noneLabel}</option> : null}
      <option value="root">Début du pack</option>
      <option value={NAV_TARGET_NEXT_STORY}>Histoire suivante</option>
      {allMenus.length > 0 && (
        <optgroup label="Dossiers">
          {allMenus.map((menu) => (
            <option key={`target-menu-${menu.id}`} value={encodeMenuNavigationTarget(menu.id)}>
              {menu.name || '(sans nom)'}
            </option>
          ))}
        </optgroup>
      )}
      {allStories.length > 0 && (
        <>
          <optgroup label="Histoires — titre">
            {allStories.filter((s) => s.id !== currentStoryId).map((story) => (
              <option key={`target-story-${story.id}`} value={encodeStoryNavigationTarget(story.id)}>
                {story.name || '(sans nom)'}
              </option>
            ))}
          </optgroup>
          <optgroup label="Histoires — lecture directe">
            {allStories.filter((s) => s.id !== currentStoryId).map((story) => (
              <option key={`target-story-play-${story.id}`} value={encodeStoryPlayNavigationTarget(story.id)}>
                Lecture directe — {story.name || '(sans nom)'}
              </option>
            ))}
          </optgroup>
          {allStories.some((s) => s.id !== currentStoryId && s.hasAfterPlaybackHomeStep) ? (
            <optgroup label="Histoires — retour de fin">
              {allStories
                .filter((s) => s.id !== currentStoryId && s.hasAfterPlaybackHomeStep)
                .map((story) => (
                  <option key={`target-story-home-step-${story.id}`} value={encodeStoryHomeStepNavigationTarget(story.id)}>
                    Retour de fin — {story.name || '(sans nom)'}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </>
      )}
    </select>
  );
}
