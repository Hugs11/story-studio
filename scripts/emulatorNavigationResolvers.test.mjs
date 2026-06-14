import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeHomeTarget,
  resolveSequenceTarget,
  resolveStoryHomeTarget,
  resolveStoryReturnTarget,
} from '../src/tabs/EmulatorTab/navigationResolvers.js';

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
