import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCircularSelectionIndex,
  getMenuBrowseState,
  normalizeHomeTarget,
  resolveSequenceTarget,
  resolveStoryHomeTarget,
  resolveStoryReturnTarget,
  resolveStoryTitleHomeTarget,
} from '../src/tabs/EmulatorTab/navigationResolvers.js';

test('wheel selection wraps in both directions', () => {
  assert.equal(getCircularSelectionIndex(0, -1, 3), 2);
  assert.equal(getCircularSelectionIndex(2, 1, 3), 0);
  assert.equal(getCircularSelectionIndex(1, -1, 3), 0);
  assert.equal(getCircularSelectionIndex(1, 1, 3), 2);
});

test('wheel selection stays stable when there is no selectable item', () => {
  assert.equal(getCircularSelectionIndex(0, 1, 0), 0);
  assert.equal(getCircularSelectionIndex(0, -1, 0), 0);
});

test('sequence destinations preserve direct story playback', () => {
  assert.equal(resolveSequenceTarget('story:target', null), 'story:target');
  assert.equal(resolveSequenceTarget('story_play:target', null), 'story_play:target');
});

test('explicit Home destinations normalize direct playback to the story title', () => {
  assert.equal(normalizeHomeTarget('story_play:target'), 'story:target');
  assert.equal(normalizeHomeTarget('story:target'), 'story:target');
});

test('story return can use direct playback while story Home opens the story title', () => {
  const story = {
    id: 'source',
    type: 'story',
    returnAfterPlay: 'story_play:target',
    returnOnHome: 'story_play:target',
  };

  assert.equal(resolveStoryReturnTarget(story, null, null), 'story_play:target');
  assert.equal(resolveStoryHomeTarget(story, null, null), 'story:target');
});

test('imported story Home preserves direct playback targets', () => {
  const story = {
    id: 'source',
    type: 'story',
    nativeStageId: 'native-source',
    returnOnHome: 'story_play:target',
  };

  assert.equal(resolveStoryHomeTarget(story, null, null), 'story_play:target');
});

test('story title Home returns to its immediate folder while a root story returns to the cover', () => {
  const nestedStory = { id: 'nested', type: 'story' };
  const nestedMenu = { id: 'nested-menu', type: 'menu', children: [nestedStory] };
  const parentMenu = { id: 'parent-menu', type: 'menu', children: [nestedMenu] };

  assert.equal(resolveStoryTitleHomeTarget(nestedStory, nestedMenu, [parentMenu]), 'nested-menu');
  assert.deepEqual(getMenuBrowseState([parentMenu], 'nested-menu'), {
    menuPath: ['parent-menu'],
    entryIdx: 0,
  });
  assert.equal(resolveStoryTitleHomeTarget(nestedStory, null, [nestedStory]), null);
});

test('story title Home preserves explicit imported targets and next-story fallback', () => {
  const first = { id: 'first', type: 'story', titleReturnOnHome: 'next_story' };
  const second = { id: 'second', type: 'story' };
  const menu = { id: 'menu', type: 'menu', children: [first, second] };

  assert.equal(resolveStoryTitleHomeTarget(first, menu), 'story:second');
  assert.equal(
    resolveStoryTitleHomeTarget({ ...second, titleReturnOnHome: 'next_story' }, menu),
    'menu',
  );
  assert.equal(
    resolveStoryTitleHomeTarget({ ...first, titleReturnOnHome: 'story_play:second' }, menu),
    'story_play:second',
  );
  assert.equal(
    resolveStoryTitleHomeTarget({ ...first, titleReturnOnHomeNone: true }, menu),
    null,
  );
});
