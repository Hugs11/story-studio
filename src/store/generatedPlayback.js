function hasNonEmptyValue(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function getStoryPlaySimpleLeafPlayback(entry, parentMenu, project) {
  if (!!project?.globalOptions?.autoNext) return true;
  if (!parentMenu) return false;
  return !hasNonEmptyValue(parentMenu.returnAfterPlay) && !hasNonEmptyValue(entry?.returnAfterPlay);
}

export function getGeneratedStoryPlayControls(entry, parentMenu, project) {
  const controls = entry?.controlSettings ?? {};
  const autoNextActive = !!project?.globalOptions?.autoNext;
  const hasEffectiveNightMode = !!project?.nightModeAudio && !autoNextActive;
  const simpleLeafPlayback = getStoryPlaySimpleLeafPlayback(entry, parentMenu, project);
  const configuredAutoplay = controls.autoplay === true;
  const configuredOk = controls.ok === true;
  const forceAutoplay = !!(
    autoNextActive
    || hasNonEmptyValue(entry?.returnAfterPlay)
    || hasEffectiveNightMode
    || (simpleLeafPlayback && !configuredOk && !configuredAutoplay)
  );

  return {
    wheel: controls.wheel === true,
    ok: configuredOk,
    home: controls.home ?? true,
    pause: controls.pause ?? true,
    autoplay: forceAutoplay || configuredAutoplay,
    forceAutoplay,
  };
}

export function getGeneratedMenuControls(menu, parentMenu, project) {
  const controls = menu?.controlSettings ?? {};
  const isRootMenu = !parentMenu;
  const rootHasMultipleEntries = (project?.rootEntries?.length ?? 0) > 1;
  const forceChoiceNode = isRootMenu && rootHasMultipleEntries;
  const isChoiceNode = !!(
    hasNonEmptyValue(menu?.returnOnHome)
    || parentMenu
    || forceChoiceNode
  );

  return {
    wheel: isChoiceNode ? (controls.wheel ?? true) : false,
    ok: controls.ok ?? true,
    home: controls.home ?? true,
    pause: controls.pause ?? false,
    autoplay: isChoiceNode ? (controls.autoplay ?? false) : true,
    isChoiceNode,
    forceAutoplay: !isChoiceNode,
  };
}
