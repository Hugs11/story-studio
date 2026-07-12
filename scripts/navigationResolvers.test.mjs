import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOME_ACTION,
  resolveEndNodeHomeTarget,
  resolvePromptHomeAction,
} from '../src/tabs/EmulatorTab/navigationResolvers.js';

function story(id, fields = {}) {
  return { id, type: 'story', name: id.toUpperCase(), ...fields };
}

function promptStory(id, fields = {}) {
  return story(id, { afterPlaybackPromptAudio: 'p.mp3', ...fields });
}

// resolveEndNodeHomeTarget : volet Home du message de fin global, consommé par le
// ProjectSimulator pour rester à parité avec le ZipSimulator / story.json.

test('endnode home: empty global home is none (return to squareOne, never follows OK)', () => {
  assert.deepEqual(resolveEndNodeHomeTarget({}, null), { kind: 'none', targetId: null });
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: '' }, null),
    { kind: 'none', targetId: null },
  );
  // Un retour OK défini ne fait pas basculer le Home vide en cible : Home reste `none`.
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeReturn: 'root' }, null),
    { kind: 'none', targetId: null },
  );
});

test('endnode home: explicit target is resolved', () => {
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'root' }, null),
    { kind: 'target', targetId: 'root' },
  );
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'menu:m1' }, null),
    { kind: 'target', targetId: 'm1' },
  );
});

test('endnode home: current_menu falls back to the OK destination (matches Rust), not the parent menu', () => {
  // Rust résout NavigationTarget::CurrentMenu vers fallback_transition (= destination OK du
  // message), pas le menu parent. targetId null → l'appelant suit le retour OK.
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'current_menu' }, { id: 'menu-1' }),
    { kind: 'target', targetId: null },
  );
});

test('endnode home: next_story stays a literal for contextual per-story resolution', () => {
  // L'appelant (simulateur) résout `next_story` sur la sœur suivante de l'histoire source.
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'next_story' }, null),
    { kind: 'target', targetId: 'next_story' },
  );
});

// resolvePromptHomeAction : volet Home d'un prompt local, aligné sur Rust.

test('prompt home action: homeNone returns to the pack start', () => {
  const a = promptStory('a', { afterPlaybackPromptHomeNone: true });
  assert.deepEqual(resolvePromptHomeAction(a, null, [a]), { action: HOME_ACTION.COVER });
});

test('prompt home action: no target follows the prompt OK path', () => {
  const a = promptStory('a', { afterPlaybackPromptOkTarget: 'root' });
  assert.deepEqual(resolvePromptHomeAction(a, null, [a]), { action: HOME_ACTION.MESSAGE_OK });
});

test('prompt home action: explicit target is navigated directly', () => {
  const a = promptStory('a', { afterPlaybackPromptHomeTarget: 'menu:m1' });
  assert.deepEqual(resolvePromptHomeAction(a, null, [a]), { action: HOME_ACTION.TARGET, targetId: 'm1' });
});

test('prompt home action: next_story with a following sibling targets its approach', () => {
  const a = promptStory('a', { afterPlaybackPromptHomeTarget: 'next_story' });
  const b = story('b');
  assert.deepEqual(
    resolvePromptHomeAction(a, null, [a, b]),
    { action: HOME_ACTION.TARGET, targetId: 'story:b' },
  );
});

test('prompt home action: next_story on the LAST story falls back to the prompt OK path (P1)', () => {
  const a = story('a');
  const b = promptStory('b', {
    afterPlaybackPromptOkTarget: 'root',
    afterPlaybackPromptHomeTarget: 'next_story',
  });
  // Dernière sœur : jamais le Home de l'histoire, mais la destination OK du prompt.
  assert.deepEqual(resolvePromptHomeAction(b, null, [a, b]), { action: HOME_ACTION.MESSAGE_OK });
});

test('prompt home action: current_menu follows the prompt OK path (P2), not the parent menu', () => {
  const a = promptStory('a', { afterPlaybackPromptHomeTarget: 'current_menu' });
  const menu = { id: 'menu-1', type: 'menu', children: [a] };
  assert.deepEqual(resolvePromptHomeAction(a, menu, []), { action: HOME_ACTION.MESSAGE_OK });
});

test('prompt home action: story_play targets the story approach, not direct playback', () => {
  const a = promptStory('a', { afterPlaybackPromptHomeTarget: 'story_play:b' });
  assert.deepEqual(
    resolvePromptHomeAction(a, null, [a, story('b')]),
    { action: HOME_ACTION.TARGET, targetId: 'story:b' },
  );
});

test('endnode home: next_story resolves to the source story next sibling approach', () => {
  const a = story('a');
  const b = story('b');
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'next_story' }, null, a, [a, b]),
    { kind: 'target', targetId: 'story:b' },
  );
});

test('endnode home: story_play is normalized to the story approach', () => {
  assert.deepEqual(
    resolveEndNodeHomeTarget({ nightModeHomeReturn: 'story_play:b' }, null),
    { kind: 'target', targetId: 'story:b' },
  );
});
