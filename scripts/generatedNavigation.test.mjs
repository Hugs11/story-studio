import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXTUAL_NEXT_STORY_TARGET,
  getDefaultPackEntryDestination,
  getEffectiveEndBehavior,
  getGeneratedEndNodeHomeNavigation,
  getGeneratedEndNodeReturnNavigation,
  getGeneratedStoryNavigation,
  hasGeneratedEndNode,
  hasVisibleEndNode,
  isCombinedNightStoryBypass,
} from '../src/store/generatedNavigation.js';
import {
  getGeneratedMenuControls,
  getGeneratedStoryPlayControls,
} from '../src/store/generatedPlayback.js';

function story(id, fields = {}) {
  return {
    id,
    type: 'story',
    name: id.toUpperCase(),
    audio: `${id}.mp3`,
    itemAudio: `${id}-title.mp3`,
    controlSettings: {},
    ...fields,
  };
}

function project(rootEntries, fields = {}) {
  return {
    projectType: 'pack',
    rootEntries,
    globalOptions: {},
    ...fields,
  };
}

test('direct returnAfterPlay is exposed when no end node is generated', () => {
  const a = story('a', { returnAfterPlay: 'root' });
  const nav = getGeneratedStoryNavigation(a, null, project([a]), [a]);

  assert.equal(nav.usesEndNode, false);
  assert.equal(nav.directReturn.isModified, true);
  assert.equal(nav.directReturn.targetId, 'root');
});

test('story Home remains visible even when it matches the end target', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', returnAfterPlay: 'root', children: [] };
  const a = story('a', { returnOnHome: 'root' });
  menu.children = [a];
  const nav = getGeneratedStoryNavigation(a, menu, project([menu]), [menu]);

  assert.equal(nav.storyHome.isConfigured, true);
  assert.equal(nav.storyHome.targetId, 'root');
  assert.equal(nav.directReturn.targetId, 'root');
});

test('end node does not hide a story returnOnHome override', () => {
  const a = story('a', { returnOnHome: 'root' });
  const p = project([a], {
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'root',
    globalOptions: { nightMode: true, endNode: true },
  });

  const nav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);

  assert.equal(nav.usesEndNode, true);
  assert.equal(nav.directReturn.isBypassedByEndNode, true);
  assert.equal(nav.endNodeReturn.targetId, 'root');
  assert.equal(nav.storyHome.isConfigured, true);
  assert.equal(nav.storyHome.targetId, 'root');
});

test('returnOnHomeNone is a visible modified behavior', () => {
  const a = story('a', { returnOnHomeNone: true });
  const nav = getGeneratedStoryNavigation(a, null, project([a]), [a]);

  assert.equal(nav.storyHome.isNone, true);
  assert.equal(nav.storyHome.targetId, null);
});

test('nightModeReturn next_story resolves by source story and stays contextual globally', () => {
  const a = story('a');
  const b = story('b');
  const p = project([a, b], {
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'next_story',
    globalOptions: { nightMode: true },
  });

  const aNav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);
  const bNav = getGeneratedStoryNavigation(b, null, p, p.rootEntries);
  const endNodeReturn = getGeneratedEndNodeReturnNavigation(p);

  assert.equal(aNav.usesEndNode, true);
  assert.equal(aNav.endNodeReturn.targetId, 'story:b');
  assert.equal(bNav.endNodeReturn.targetId, 'story:b');
  assert.equal(endNodeReturn.targetId, CONTEXTUAL_NEXT_STORY_TARGET);
});

test('nightModeHomeReturn next_story is contextual on the global end node badge', () => {
  const a = story('a');
  const b = story('b');
  const p = project([a, b], {
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'root',
    nightModeHomeReturn: 'next_story',
    globalOptions: { nightMode: true },
  });

  const home = getGeneratedEndNodeHomeNavigation(p);

  assert.equal(home.targetId, CONTEXTUAL_NEXT_STORY_TARGET);
  assert.equal(home.isNightMode, true);
});

test('local prompt Home is distinct from end-node Home', () => {
  const a = story('a', {
    afterPlaybackPromptAudio: 'prompt.mp3',
    afterPlaybackPromptOkTarget: 'root',
    afterPlaybackPromptHomeTarget: 'story:b',
  });
  const b = story('b');
  const p = project([a, b], {
    nightModeAudio: 'night.mp3',
    nightModeHomeReturn: 'next_story',
    globalOptions: { nightMode: true },
  });
  const nav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);

  assert.equal(nav.usesEndNode, false);
  assert.equal(nav.promptReturn.targetId, 'root');
  assert.equal(nav.promptHome.targetId, 'story:b');
  assert.equal(getGeneratedEndNodeHomeNavigation(p).targetId, CONTEXTUAL_NEXT_STORY_TARGET);
});

test('imported night prompt keeps the end-node badge (option B)', () => {
  const a = story('a', {
    afterPlaybackPromptAudio: 'night.mp3',
    afterPlaybackPromptOkTarget: 'root',
  });
  const p = project([a], {
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'root',
    globalOptions: { nightMode: true },
  });
  const nav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);

  assert.equal(nav.endNodeReturn.isActive, true);
  assert.equal(nav.endNodeReturn.isImportedPrompt, true);
  assert.equal(nav.endNodeReturn.targetId, 'root');
  assert.equal(nav.promptReturn.isImportedNightPrompt, true);
});

test('configured Home on a disabled Home button is marked inactive', () => {
  const a = story('a', {
    returnOnHome: 'root',
    controlSettings: { home: false },
  });
  const nav = getGeneratedStoryNavigation(a, null, project([a]), [a]);

  assert.equal(nav.storyHome.isConfigured, true);
  assert.equal(nav.storyHome.isInactive, true);
});

test('combined night story bypass mirrors native_pack should_emit_combined_story_stage gate', () => {
  const a = story('a', {
    audio: 'same.mp3',
    itemAudio: 'same.mp3',
    returnAfterPlay: 'root',
    controlSettings: { wheel: true, autoplay: true },
  });
  const p = project([a], {
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'root',
    globalOptions: { nightMode: true },
  });
  const nav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);

  assert.equal(isCombinedNightStoryBypass(a, p), true);
  assert.equal(nav.usesEndNode, false);
  assert.equal(nav.directReturn.isModified, true);
});

test('combined gate without returnAfterPlay still routes through end node', () => {
  const a = story('a', {
    audio: 'same.mp3',
    itemAudio: 'same.mp3',
    controlSettings: { wheel: true, autoplay: true },
  });
  const p = project([a], {
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'root',
    globalOptions: { nightMode: true },
  });
  const nav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);

  assert.equal(isCombinedNightStoryBypass(a, p), false);
  assert.equal(nav.usesEndNode, true);
});

test('end node fallback for a menu story uses the menu (mirrors Rust compute_night_bridge_targets fallback)', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  menu.children = [a];
  const p = project([menu], {
    nightModeAudio: 'night.mp3',
    // nightModeReturn vide → fallback contextuel par histoire
    globalOptions: { nightMode: true },
  });

  const nav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);

  assert.equal(nav.endNodeReturn.isActive, true);
  assert.equal(nav.endNodeReturn.isConfigured, false);
  assert.equal(nav.endNodeReturn.targetId, null);
  assert.equal(nav.endNodeReturn.effectiveTargetId, 'menu-1');
});

test('end node fallback respects explicit story returnAfterPlay', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const target = story('target');
  const a = story('a', { returnAfterPlay: 'story:target' });
  menu.children = [a, target];
  const p = project([menu], {
    nightModeAudio: 'night.mp3',
    globalOptions: { nightMode: true },
  });

  const nav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);

  assert.equal(nav.endNodeReturn.effectiveTargetId, 'story:target');
});

test('autoNext: story without override returns to next sibling (mirrors Rust auto_next_active)', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const nav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);

  assert.equal(nav.directReturn.targetId, 'story_play:b');
  // Pas marqué comme modifié : l'utilisateur n'a pas configuré returnAfterPlay
  assert.equal(nav.directReturn.isModified, false);
});

test('menu autoplay disabled is preserved when the menu is a real root choice', () => {
  const first = { id: 'menu-1', type: 'menu', name: 'Menu 1', controlSettings: { autoplay: false }, children: [story('a')] };
  const second = { id: 'menu-2', type: 'menu', name: 'Menu 2', controlSettings: { autoplay: false }, children: [story('b')] };
  const p = project([first, second]);

  const controls = getGeneratedMenuControls(first, null, p);

  assert.equal(controls.isChoiceNode, true);
  assert.equal(controls.autoplay, false);
  assert.equal(controls.forceAutoplay, false);
});

test('single root menu is forced to autoplay even when its local autoplay is disabled', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', controlSettings: { autoplay: false }, children: [story('a')] };
  const p = project([menu]);

  const controls = getGeneratedMenuControls(menu, null, p);

  assert.equal(controls.isChoiceNode, false);
  assert.equal(controls.autoplay, true);
  assert.equal(controls.forceAutoplay, true);
});

test('default story inside a menu auto-continues when Rust forces playback autoplay', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a', { controlSettings: { ok: false, autoplay: false } });
  menu.children = [a];
  const p = project([menu]);

  const controls = getGeneratedStoryPlayControls(a, menu, p);
  const behavior = getEffectiveEndBehavior(a, menu, p, p.rootEntries);

  assert.equal(controls.forceAutoplay, true);
  assert.equal(controls.autoplay, true);
  assert.equal(behavior.autoContinuation, true);
  assert.equal(behavior.finalTargetId, 'menu-1');
});

test('story inside a menu can stay on screen when OK is enabled', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a', { controlSettings: { ok: true, autoplay: false } });
  menu.children = [a];
  const p = project([menu]);

  const controls = getGeneratedStoryPlayControls(a, menu, p);
  const behavior = getEffectiveEndBehavior(a, menu, p, p.rootEntries);

  assert.equal(controls.forceAutoplay, false);
  assert.equal(controls.autoplay, false);
  assert.equal(behavior.autoContinuation, false);
  assert.equal(behavior.finalTargetId, null);
});

test('effective end behavior: autoNext without end step goes directly to next story playback', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const behavior = getEffectiveEndBehavior(a, menu, p, p.rootEntries);

  assert.equal(behavior.autoNext.applies, true);
  assert.equal(behavior.autoNext.hasNextStory, true);
  assert.equal(behavior.usesEndStep, false);
  assert.equal(behavior.finalTargetId, 'story_play:b');
  assert.equal(behavior.autoContinuation, true);
});

test('effective end behavior: autoNext suppresses the global end node', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], {
    nightModeAudio: 'night.mp3',
    globalOptions: { autoNext: true, nightMode: true },
  });

  const behavior = getEffectiveEndBehavior(a, menu, p, p.rootEntries);

  assert.equal(behavior.autoNext.applies, true);
  assert.equal(behavior.usesEndStep, false);
  assert.equal(behavior.endStepKind, null);
  assert.equal(behavior.finalTargetId, 'story_play:b');
});

test('effective end behavior: autoNext suppresses a local prompt', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a', { afterPlaybackPromptAudio: 'end-a.mp3' });
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const behavior = getEffectiveEndBehavior(a, menu, p, p.rootEntries);

  assert.equal(behavior.autoNext.applies, true);
  assert.equal(behavior.usesEndStep, false);
  assert.equal(behavior.endStepKind, null);
  assert.equal(behavior.navigation.hasPrompt, false);
  assert.equal(behavior.finalTargetId, 'story_play:b');
});

test('effective end behavior: autoNext overrides explicit story return', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a', { returnAfterPlay: 'root' });
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const behavior = getEffectiveEndBehavior(a, menu, p, p.rootEntries);

  assert.equal(behavior.autoNext.applies, true);
  assert.equal(behavior.navigation.directReturn.targetId, 'story_play:b');
  assert.equal(behavior.navigation.directReturn.isModified, false);
  assert.equal(behavior.finalTargetId, 'story_play:b');
});

test('effective end behavior: autoNext last story falls back to parent menu', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const behavior = getEffectiveEndBehavior(b, menu, p, p.rootEntries);

  assert.equal(behavior.autoNext.applies, true);
  assert.equal(behavior.autoNext.hasNextStory, false);
  assert.equal(behavior.autoNext.isLastStory, true);
  assert.equal(behavior.finalTargetId, 'menu-1');
});

test('autoNext combined with end-node suppresses the end node', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], {
    nightModeAudio: 'night.mp3',
    globalOptions: { autoNext: true, nightMode: true },
  });

  const nav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);

  assert.equal(nav.endNodeReturn.isActive, false);
  assert.equal(nav.endNodeReturn.isConfigured, false);
  assert.equal(nav.endNodeReturn.effectiveTargetId, null);
  assert.equal(nav.usesEndNode, false);
  assert.equal(nav.directReturn.targetId, 'story_play:b');
});

test('nativeGraph preserve does not mask autoNext preview behavior', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a', { nativeStageId: 'stage-a' });
  const b = story('b', { nativeStageId: 'stage-b' });
  menu.children = [a, b];
  const p = project([menu], {
    nativeGraph: {
      preserveForRoundTrip: true,
      document: { stageNodes: [], actionNodes: [] },
    },
    globalOptions: { autoNext: true },
  });

  const nav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);

  assert.equal(nav.directReturn.targetId, 'story_play:b');
  assert.equal(nav.usesEndNode, false);
});

test('autoNext: last story of a menu falls back to menu parent', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const nav = getGeneratedStoryNavigation(b, menu, p, p.rootEntries);

  assert.equal(nav.directReturn.targetId, 'menu-1');
});

test('autoNext: explicit returnAfterPlay is ignored by auto_next', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', children: [] };
  const a = story('a', { returnAfterPlay: 'root' });
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu], { globalOptions: { autoNext: true } });

  const nav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);

  assert.equal(nav.directReturn.targetId, 'story_play:b');
  assert.equal(nav.directReturn.isModified, false);
});

test('end node fallback for a root story keeps its root index target', () => {
  const a = story('a');
  const p = project([a], {
    nightModeAudio: 'night.mp3',
    globalOptions: { nightMode: true },
  });

  const nav = getGeneratedStoryNavigation(a, null, p, p.rootEntries);

  // À la racine, sans parent menu et sans returnAfterPlay, le fallback retombe
  // sur l'option racine de cette histoire (transition(root_action_id, root_index)).
  assert.equal(nav.endNodeReturn.isActive, true);
  assert.equal(nav.endNodeReturn.effectiveTargetId, 'story:a');
});

test('end node fallback for second root story keeps its root index target', () => {
  const a = story('a');
  const b = story('b');
  const p = project([a, b], {
    nightModeAudio: 'night.mp3',
    globalOptions: { nightMode: true },
  });

  const nav = getGeneratedStoryNavigation(b, null, p, p.rootEntries);

  assert.equal(nav.endNodeReturn.effectiveTargetId, 'story:b');
});

test('menu returnAfterPlay next_story resolves by child source story', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Menu', returnAfterPlay: 'next_story', children: [] };
  const a = story('a');
  const b = story('b');
  menu.children = [a, b];
  const p = project([menu]);

  const aNav = getGeneratedStoryNavigation(a, menu, p, p.rootEntries);
  const bNav = getGeneratedStoryNavigation(b, menu, p, p.rootEntries);

  assert.equal(aNav.directReturn.targetId, 'story:b');
  assert.equal(bNav.directReturn.targetId, 'menu-1');
});

test('default pack destination resolves to the first root entry (mirrors Rust transition(root_action_id, 0))', () => {
  const menu = { id: 'menu-1', type: 'menu', name: 'Quelle histoire ?', children: [] };
  const story1 = story('s1');
  const p = project([menu, story1]);

  const dest = getDefaultPackEntryDestination(p);

  assert.equal(dest.id, 'menu-1');
  assert.equal(dest.name, 'Quelle histoire ?');
  assert.equal(dest.type, 'menu');
});

test('default pack destination returns null for empty project', () => {
  const p = project([]);
  assert.equal(getDefaultPackEntryDestination(p), null);
});

test('endNode without audio is visible-only and not generated', () => {
  const p = project([], {
    globalOptions: { endNode: true },
  });

  assert.equal(hasVisibleEndNode(p), true);
  assert.equal(hasGeneratedEndNode(p), false);
  assert.equal(getGeneratedEndNodeHomeNavigation({ ...p, nightModeHomeReturn: 'root' }), null);
});

test('autoNext hides visible/generated end node controls', () => {
  const p = project([], {
    nightModeAudio: 'night.mp3',
    globalOptions: { autoNext: true, nightMode: true, endNode: true },
  });

  assert.equal(hasVisibleEndNode(p), false);
  assert.equal(hasGeneratedEndNode(p), false);
  assert.equal(getGeneratedEndNodeReturnNavigation(p), null);
});

test('end node global return without setting is marked contextual, not root', () => {
  const a = story('a');
  const p = project([a], {
    nightModeAudio: 'night.mp3',
    globalOptions: { nightMode: true },
  });

  const nav = getGeneratedEndNodeReturnNavigation(p);

  assert.equal(nav.targetId, null);
  assert.equal(nav.isExplicit, false);
  assert.equal(nav.isContextual, true);
  assert.equal(nav.isDefaultContextual, true);
});
