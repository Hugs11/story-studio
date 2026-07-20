import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildMediaAudioToolRequest,
  createMediaToolSourceSignature,
  getAudioAssemblyLogicalFileName,
  getAssemblyReplacementEligibility,
  getMediaToolAutomaticProjectAction,
  haveSameMediaPathMultiset,
  resolveAudioStoriesInProjectOrder,
  validateMediaAudioToolRequest,
} from '../src/store/mediaToolContext.js';
import {
  replaceStoriesWithAssembledStory,
} from '../src/store/projectModel/audioTransformations.js';

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
    requestId: fields.requestId ?? 'request-1',
  });
  assert.equal(built.valid, true);
  return built.request;
}

test('contextual assembly derives a logical filename from numbered tree-node parts', () => {
  assert.equal(getAudioAssemblyLogicalFileName({
    storyNames: ['L’Oie d’or Pt 01', 'L’Oie d’or Pt 02', 'L’Oie d’or Pt 03'],
    projectPrefix: 'comtes',
  }), 'L’Oie d’or.flac');
});

test('standalone assembly removes the project prefix before suggesting a filename', () => {
  assert.equal(getAudioAssemblyLogicalFileName({
    items: [
      { name: 'comtes__chapitre_01.flac' },
      { name: 'comtes__chapitre_02.flac' },
    ],
    projectPrefix: 'comtes',
  }), 'chapitre_0_assemble.flac');
});

test('audio stories follow project order instead of Set insertion order', () => {
  const value = project([menu('menu', [story('a'), story('b'), story('c')])]);
  const resolved = resolveAudioStoriesInProjectOrder(value, new Set(['c', 'a', 'b']));
  assert.equal(resolved.valid, true);
  assert.deepEqual(resolved.entryIds, ['a', 'b', 'c']);
  assert.deepEqual(resolved.sourcePaths, ['a.mp3', 'b.mp3', 'c.mp3']);
});

test('tree split requests only carry the shortcut context', () => {
  const value = project([story('a')]);
  const request = requestFor(value, ['a']);

  assert.equal(request.tool, 'split');
  assert.equal(request.mode, undefined);
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

test('root stories created by audio imports are replaced automatically after explicit contextual assembly', () => {
  const value = project([
    story('podcast-1', { returnAfterPlay: 'root' }),
    story('podcast-2', { returnAfterPlay: 'root' }),
  ]);
  const request = requestFor(value, ['podcast-2', 'podcast-1']);
  const eligibility = getAssemblyReplacementEligibility(value, request.entryIds);

  assert.equal(eligibility.valid, true);
  assert.equal(getMediaToolAutomaticProjectAction({
    request,
    contextValidation: { valid: true },
    replacementEligibility: eligibility,
  }), 'replace-stories-with-assembly');
});

test('automatic assembly replacement is unavailable outside a safe contextual request', () => {
  const value = project([story('a'), story('b')]);
  const request = requestFor(value, ['a', 'b']);
  const eligibility = getAssemblyReplacementEligibility(value, request.entryIds);

  assert.equal(getMediaToolAutomaticProjectAction({
    request: { ...request, origin: 'media' },
    contextValidation: { valid: true },
    replacementEligibility: eligibility,
  }), null);
  assert.equal(getMediaToolAutomaticProjectAction({
    request,
    contextValidation: { valid: false },
    replacementEligibility: eligibility,
  }), null);
});

test('assembly input validation accepts modal reordering but requires the same sources', () => {
  assert.equal(haveSameMediaPathMultiset(
    ['one.mp3', 'two.mp3', 'three.mp3'],
    ['three.mp3', 'one.mp3', 'two.mp3'],
  ), true);
  assert.equal(haveSameMediaPathMultiset(
    ['same.mp3', 'same.mp3', 'other.mp3'],
    ['other.mp3', 'same.mp3', 'same.mp3'],
  ), true);
  assert.equal(haveSameMediaPathMultiset(
    ['one.mp3', 'two.mp3'],
    ['one.mp3'],
  ), false);
  assert.equal(haveSameMediaPathMultiset(
    ['one.mp3', 'two.mp3'],
    ['one.mp3', 'other.mp3'],
  ), false);
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

test('assembly retains first position and visuals, uses the logical title, and takes the last terminal behavior', () => {
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
  const outcome = replaceStoriesWithAssembledStory(value, {
    request,
    outputPath: 'comtes__L’Oie d’or.flac',
    logicalName: 'L’Oie d’or',
  });
  assert.equal(outcome.ok, true);
  const children = outcome.project.rootEntries[0].children;
  assert.deepEqual(children.map((entry) => entry.id), ['a', 'after']);
  assert.equal(children[0].name, 'L’Oie d’or');
  assert.equal(children[0].itemAudio, 'first-title.mp3');
  assert.equal(children[0].itemImage, 'first.png');
  assert.equal(children[0].audio, 'comtes__L’Oie d’or.flac');
  assert.equal(children[0].returnAfterPlay, 'root');
  assert.equal(children[0].returnOnHome, 'story:a');
  assert.equal(children[0].afterPlaybackSequence[0].audio, 'end.mp3');
});
