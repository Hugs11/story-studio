import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeAudioSegmentCoverage,
  buildMediaAudioToolRequest,
  createMediaToolSourceSignature,
  getAssemblyReplacementEligibility,
  getMediaToolProjectActions,
  resolveAudioStoriesInProjectOrder,
  validateMediaAudioToolRequest,
} from '../src/store/mediaToolContext.js';
import {
  replaceStoriesWithAssembledStory,
  replaceStoryWithAudioParts,
} from '../src/store/projectModel/audioTransformations.js';
import { getEffectiveEndBehavior } from '../src/store/generatedNavigation.js';

function story(id, fields = {}) {
  return {
    id,
    type: 'story',
    name: id,
    audio: `${id}.mp3`,
    itemAudio: `${id}-title.mp3`,
    itemImage: `${id}.png`,
    controlSettings: { autoplay: true, wheel: false, pause: true, ok: false, home: true },
    afterPlaybackSequence: [],
    ...fields,
  };
}

function menu(id, children) {
  return { id, type: 'menu', name: id, children };
}

function project(rootEntries) {
  return {
    projectType: 'pack',
    rootEntries,
    globalOptions: { autoNext: false, nightMode: false },
    nightModeAudio: null,
  };
}

function requestFor(value, ids, fields = {}) {
  const built = buildMediaAudioToolRequest({
    project: value,
    entryIds: ids,
    origin: fields.origin ?? 'tree',
    tool: fields.tool ?? (ids.length === 1 ? 'split' : 'assemble'),
    mode: fields.mode,
    requestId: fields.requestId ?? 'request-1',
  });
  assert.equal(built.valid, true);
  return built.request;
}

test('audio stories follow project order instead of Set insertion order', () => {
  const value = project([menu('menu', [story('a'), story('b'), story('c')])]);
  const resolved = resolveAudioStoriesInProjectOrder(value, new Set(['c', 'a', 'b']));
  assert.equal(resolved.valid, true);
  assert.deepEqual(resolved.entryIds, ['a', 'b', 'c']);
  assert.deepEqual(resolved.sourcePaths, ['a.mp3', 'b.mp3', 'c.mp3']);
});

test('media-origin operations and partial extractions expose no structural replacement', () => {
  const result = {
    createdPaths: ['part.flac'],
    segments: [{ startSec: 1, endSec: 2 }],
    failures: [],
  };
  assert.deepEqual(getMediaToolProjectActions({
    request: { origin: 'media', tool: 'split', mode: 'extract' },
    result,
    contextValidation: { valid: true },
  }), []);

  assert.deepEqual(getMediaToolProjectActions({
    request: { origin: 'tree', tool: 'split', mode: 'extract' },
    result,
    contextValidation: { valid: true },
  }), ['use-as-item-audio', 'replace-story-audio']);
  assert.ok(!getMediaToolProjectActions({
    request: { origin: 'tree', tool: 'split', mode: 'extract' },
    result,
    contextValidation: { valid: true },
  }).includes('replace-story-with-parts'));
});

test('full coverage accepts joint segments inside tolerance and rejects gaps, overlaps, bounds, and missing outputs', () => {
  const joint = [
    { startSec: 0, endSec: 5 },
    { startSec: 5.01, endSec: 10 },
  ];
  assert.equal(analyzeAudioSegmentCoverage(joint, 10).valid, true);
  assert.equal(analyzeAudioSegmentCoverage([
    { startSec: 0, endSec: 4 },
    { startSec: 4.1, endSec: 10 },
  ], 10).code, 'gap');
  assert.equal(analyzeAudioSegmentCoverage([
    { startSec: 0, endSec: 5.1 },
    { startSec: 5, endSec: 10 },
  ], 10).code, 'overlap');
  assert.equal(analyzeAudioSegmentCoverage([
    { startSec: -1, endSec: 5 },
    { startSec: 5, endSec: 10 },
  ], 10).code, 'invalid-bounds');

  const actions = getMediaToolProjectActions({
    request: { origin: 'tree', tool: 'split', mode: 'full-split' },
    result: { createdPaths: ['one.flac'], segments: joint, failures: [], coverage: { valid: true } },
    contextValidation: { valid: true },
  });
  assert.deepEqual(actions, []);
});

test('assembly replacement requires consecutive stories under one parent', () => {
  const separated = project([menu('menu', [story('a'), menu('nested', []), story('b')])]);
  assert.equal(getAssemblyReplacementEligibility(separated, ['a', 'b']).code, 'not-consecutive');

  const multipleParents = project([
    menu('one', [story('a')]),
    menu('two', [story('b')]),
  ]);
  assert.equal(getAssemblyReplacementEligibility(multipleParents, ['a', 'b']).code, 'multiple-parents');
});

test('ordinary consecutive stories are replaceable while an explicit divergent return is ambiguous', () => {
  const ordinary = project([menu('menu', [story('a'), story('b')])]);
  assert.equal(getAssemblyReplacementEligibility(ordinary, ['b', 'a']).valid, true);

  const divergent = project([menu('menu', [
    story('a', { returnAfterPlay: 'root' }),
    story('b'),
  ])]);
  assert.equal(getAssemblyReplacementEligibility(divergent, ['a', 'b']).code, 'ambiguous-navigation');
});

test('a changed source signature invalidates the contextual request', () => {
  const value = project([story('a')]);
  const request = requestFor(value, ['a']);
  const edited = project([story('a', { audio: 'changed.mp3' })]);
  assert.notEqual(createMediaToolSourceSignature(edited, ['a']), request.sourceSignature);
  assert.equal(validateMediaAudioToolRequest(edited, request).code, 'source-changed');
});

test('incoming references block assembly without modifying the project', () => {
  const a = story('a', { returnAfterPlay: 'story_play:b' });
  const b = story('b', { returnAfterPlay: 'root' });
  const value = project([menu('menu', [a, b, { id: 'ref-b', type: 'ref', target: 'story:b' }])]);
  const request = requestFor(value, ['a', 'b']);
  const outcome = replaceStoriesWithAssembledStory(value, {
    request,
    outputPath: 'assembled.flac',
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'incoming-navigation');
  assert.equal(outcome.project, value);
});

test('full split retains the first identity, chains parts, copies title media, and moves the ending to the last part', () => {
  const original = story('original', {
    name: 'Le voyage',
    returnAfterPlay: 'root',
    returnOnHome: 'root',
    afterPlaybackPromptAudio: 'ending.mp3',
    afterPlaybackPromptOkTarget: 'root',
    titleControlSettings: { autoplay: false, wheel: true, pause: false, ok: true, home: true },
  });
  const value = project([menu('menu', [original])]);
  const request = requestFor(value, ['original'], { mode: 'full-split' });
  const outcome = replaceStoryWithAudioParts(value, {
    request,
    createdPaths: ['part-1.flac', 'part-2.flac', 'part-3.flac'],
  });
  assert.equal(outcome.ok, true);
  const parts = outcome.project.rootEntries[0].children;
  assert.equal(parts[0].id, 'original');
  assert.equal(parts[0].returnAfterPlay, `story_play:${parts[1].id}`);
  assert.equal(parts[1].returnAfterPlay, `story_play:${parts[2].id}`);
  assert.equal(parts[0].afterPlaybackPromptAudio, null);
  assert.equal(parts[1].afterPlaybackPromptAudio, null);
  assert.equal(parts[2].afterPlaybackPromptAudio, 'ending.mp3');
  assert.equal(parts[2].returnAfterPlay, 'root');
  assert.deepEqual(parts.map((part) => part.itemAudio), Array(3).fill('original-title.mp3'));
  assert.deepEqual(parts.map((part) => part.itemImage), Array(3).fill('original.png'));

  const parent = outcome.project.rootEntries[0];
  assert.equal(getEffectiveEndBehavior(parts[0], parent, outcome.project, outcome.project.rootEntries).finalTargetId, `story_play:${parts[1].id}`);
  assert.equal(getEffectiveEndBehavior(parts[1], parent, outcome.project, outcome.project.rootEntries).finalTargetId, `story_play:${parts[2].id}`);
});

test('assembly retains first position and title while taking the last terminal behavior', () => {
  const a = story('a', {
    name: 'Premier titre',
    itemAudio: 'first-title.mp3',
    itemImage: 'first.png',
    returnAfterPlay: 'story_play:b',
  });
  const b = story('b', {
    name: 'Dernier titre',
    itemAudio: 'last-title.mp3',
    itemImage: 'last.png',
    returnAfterPlay: 'root',
    returnOnHome: 'story:a',
    afterPlaybackSequence: [{ id: 'end', audio: 'end.mp3', okTarget: 'root' }],
  });
  const value = project([menu('menu', [a, b, story('after')])]);
  const request = requestFor(value, ['b', 'a']);
  const outcome = replaceStoriesWithAssembledStory(value, { request, outputPath: 'assembled.flac' });
  assert.equal(outcome.ok, true);
  const children = outcome.project.rootEntries[0].children;
  assert.deepEqual(children.map((entry) => entry.id), ['a', 'after']);
  assert.equal(children[0].name, 'Premier titre');
  assert.equal(children[0].itemAudio, 'first-title.mp3');
  assert.equal(children[0].itemImage, 'first.png');
  assert.equal(children[0].audio, 'assembled.flac');
  assert.equal(children[0].returnAfterPlay, 'root');
  assert.equal(children[0].returnOnHome, 'story:a');
  assert.equal(children[0].afterPlaybackSequence[0].audio, 'end.mp3');
});
