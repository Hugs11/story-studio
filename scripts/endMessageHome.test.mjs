import test from 'node:test';
import assert from 'node:assert/strict';

import {
  END_HOME_FOLLOW_OK,
  END_HOME_NONE,
  END_HOME_TARGET,
  classifyGlobalEndHome,
  classifyPromptHome,
  resolveEndHome,
  resolveEndHomeTarget,
  resolveGlobalEndHome,
  resolvePromptEndHome,
} from '../src/store/endMessageHome.js';

// --- Message de fin global (nightModeHomeReturn) : 2 états, jamais follow-ok ---

test('global end home: empty is none (no transition, back to pack start)', () => {
  assert.equal(classifyGlobalEndHome({}), END_HOME_NONE);
  assert.equal(classifyGlobalEndHome({ nightModeHomeReturn: '' }), END_HOME_NONE);
  assert.equal(classifyGlobalEndHome({ nightModeHomeReturn: '   ' }), END_HOME_NONE);
  assert.equal(classifyGlobalEndHome(null), END_HOME_NONE);
});

test('global end home: an explicit target is a resolved transition', () => {
  assert.equal(classifyGlobalEndHome({ nightModeHomeReturn: 'root' }), END_HOME_TARGET);
  assert.equal(classifyGlobalEndHome({ nightModeHomeReturn: 'next_story' }), END_HOME_TARGET);
  assert.equal(classifyGlobalEndHome({ nightModeHomeReturn: 'menu:m1' }), END_HOME_TARGET);
});

// --- Prompt de fin local : 3 états (none / follow-ok / target) ---

test('prompt home: homeNone is none', () => {
  assert.equal(classifyPromptHome({ afterPlaybackPromptHomeNone: true }), END_HOME_NONE);
  // homeNone prime sur une cible résiduelle
  assert.equal(
    classifyPromptHome({ afterPlaybackPromptHomeNone: true, afterPlaybackPromptHomeTarget: 'root' }),
    END_HOME_NONE,
  );
});

test('prompt home: no target (and not none) follows OK', () => {
  assert.equal(classifyPromptHome({}), END_HOME_FOLLOW_OK);
  assert.equal(classifyPromptHome({ afterPlaybackPromptHomeTarget: '' }), END_HOME_FOLLOW_OK);
  assert.equal(classifyPromptHome({ afterPlaybackPromptHomeNone: false }), END_HOME_FOLLOW_OK);
});

test('prompt home: an explicit target is a resolved transition', () => {
  assert.equal(classifyPromptHome({ afterPlaybackPromptHomeTarget: 'story:b' }), END_HOME_TARGET);
  assert.equal(classifyPromptHome({ afterPlaybackPromptHomeTarget: 'next_story' }), END_HOME_TARGET);
});

// --- resolveEndHome : assemble { kind, targetId } sans jamais confondre none et follow-ok ---

test('resolveEndHome: none has a null target and never inherits OK', () => {
  assert.deepEqual(
    resolveEndHome(END_HOME_NONE, { okTargetId: 'root', explicitTargetId: 'menu:m1' }),
    { kind: END_HOME_NONE, targetId: null },
  );
});

test('resolveEndHome: follow-ok inherits the OK target', () => {
  assert.deepEqual(
    resolveEndHome(END_HOME_FOLLOW_OK, { okTargetId: 'story:b' }),
    { kind: END_HOME_FOLLOW_OK, targetId: 'story:b' },
  );
  assert.deepEqual(resolveEndHome(END_HOME_FOLLOW_OK, {}), { kind: END_HOME_FOLLOW_OK, targetId: null });
});

test('resolveEndHome: target uses its explicit destination', () => {
  assert.deepEqual(
    resolveEndHome(END_HOME_TARGET, { okTargetId: 'root', explicitTargetId: 'menu:m1' }),
    { kind: END_HOME_TARGET, targetId: 'menu:m1' },
  );
});

test('effective Home target: current_menu follows the message fallback', () => {
  const story = { id: 'a', type: 'story', afterPlaybackPromptHomeTarget: 'current_menu' };
  assert.deepEqual(
    resolvePromptEndHome(story, { okTargetId: 'root' }),
    { kind: END_HOME_TARGET, targetId: 'root', effectiveTargetId: 'root' },
  );
  assert.deepEqual(
    resolveGlobalEndHome(
      { nightModeHomeReturn: 'current_menu' },
      { entry: story, okTargetId: 'root' },
    ),
    { kind: END_HOME_TARGET, targetId: 'root', effectiveTargetId: 'root' },
  );
});

test('effective Home target: next_story resolves to the next sibling approach, then falls back', () => {
  const a = { id: 'a', type: 'story', afterPlaybackPromptHomeTarget: 'next_story' };
  const b = { id: 'b', type: 'story' };
  assert.equal(
    resolvePromptEndHome(a, { rootEntries: [a, b], okTargetId: 'root' }).effectiveTargetId,
    'story:b',
  );
  assert.equal(
    resolvePromptEndHome(b, { rootEntries: [a, b], okTargetId: 'root' }).effectiveTargetId,
    'root',
  );
});

test('effective Home target: story_play is normalized to the story approach', () => {
  assert.equal(resolveEndHomeTarget('story_play:b'), 'story:b');
  const story = { id: 'a', type: 'story', afterPlaybackPromptHomeTarget: 'story_play:b' };
  assert.equal(resolvePromptEndHome(story).effectiveTargetId, 'story:b');
  assert.equal(
    resolveGlobalEndHome({ nightModeHomeReturn: 'story_play:b' }).effectiveTargetId,
    'story:b',
  );
});
