import test from 'node:test';
import assert from 'node:assert/strict';

import {
  END_HOME_FOLLOW_OK,
  END_HOME_NONE,
  END_HOME_TARGET,
  classifyGlobalEndHome,
  classifyPromptHome,
  resolveEndHome,
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
