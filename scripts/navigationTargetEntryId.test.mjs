import test from 'node:test';
import assert from 'node:assert/strict';

import { navigationTargetEntryId } from '../src/store/navigationTargets.js';

test('navigationTargetEntryId decodes story, story_play and menu targets', () => {
  assert.equal(navigationTargetEntryId('story:story-1'), 'story-1');
  assert.equal(navigationTargetEntryId('story_play:story-1'), 'story-1');
  assert.equal(navigationTargetEntryId('menu:menu-1'), 'menu-1');
  assert.equal(navigationTargetEntryId(null), null);
});
