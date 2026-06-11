import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatePathsForRelinkRoot,
  collectMissingMedia,
  relinkMediaLibraryPaths,
  relinkMediaTags,
  relinkProjectMedia,
} from '../src/store/missingMediaRelink.js';
import {
  chooseCompatibleProjectPath,
  workspaceFallbackForProjectRelativePath,
} from '../src/store/projectPathCompatibility.js';

test('collectMissingMedia groups repeated missing media references', () => {
  const project = {
    rootAudio: 'D:/moved/fichiers-importes/intro.mp3',
    rootEntries: [
      {
        id: 'story-1',
        type: 'story',
        name: 'Story',
        audio: 'D:/moved/fichiers-importes/story.mp3',
        itemAudio: 'D:/moved/fichiers-importes/intro.mp3',
      },
    ],
  };
  const missing = collectMissingMedia(project, {
    'D:/moved/fichiers-importes/intro.mp3': false,
    'D:/moved/fichiers-importes/story.mp3': true,
  });

  assert.equal(missing.length, 1);
  assert.equal(missing[0].fileName, 'intro.mp3');
  assert.equal(missing[0].count, 2);
  assert.deepEqual(missing[0].labels, ['Audio de couverture', 'Titre audio: Story']);
});

test('relinkProjectMedia replaces every matching project media path', () => {
  const project = {
    rootAudio: 'D:/moved/fichiers-importes/intro.mp3',
    rootEntries: [
      {
        id: 'story-1',
        type: 'story',
        name: 'Story',
        audio: 'D:/moved/fichiers-importes/story.mp3',
        itemAudio: 'D:/moved/fichiers-importes/intro.mp3',
      },
    ],
  };

  const relinked = relinkProjectMedia(project, {
    'D:/moved/fichiers-importes/intro.mp3': 'C:/project/fichiers-importes/intro.mp3',
  });

  assert.equal(relinked.rootAudio, 'C:/project/fichiers-importes/intro.mp3');
  assert.equal(relinked.rootEntries[0].itemAudio, 'C:/project/fichiers-importes/intro.mp3');
  assert.equal(relinked.rootEntries[0].audio, 'D:/moved/fichiers-importes/story.mp3');
  assert.equal(project.rootAudio, 'D:/moved/fichiers-importes/intro.mp3');
});

test('relink helpers update media tags and library paths', () => {
  const replacements = {
    'D:/moved/fichiers-importes/intro.mp3': 'C:/project/fichiers-importes/intro.mp3',
  };

  assert.deepEqual(
    relinkMediaTags({
      'D:/moved/fichiers-importes/intro.mp3': ['voix'],
      'C:/project/fichiers-importes/intro.mp3': ['favori'],
      'D:/moved/fichiers-importes/story.mp3': ['histoire'],
    }, replacements),
    {
      'C:/project/fichiers-importes/intro.mp3': ['voix', 'favori'],
      'D:/moved/fichiers-importes/story.mp3': ['histoire'],
    },
  );

  assert.deepEqual(
    relinkMediaLibraryPaths([
      'D:/moved/fichiers-importes/intro.mp3',
      'D:/moved/fichiers-importes/story.mp3',
    ], replacements),
    [
      'C:/project/fichiers-importes/intro.mp3',
      'D:/moved/fichiers-importes/story.mp3',
    ],
  );
});

test('candidatePathsForRelinkRoot tries managed folder suffix then basename', () => {
  assert.deepEqual(
    candidatePathsForRelinkRoot('D:/lost/fichiers-importes/story.mp3', 'C:/project'),
    [
      'C:/project/fichiers-importes/story.mp3',
      'C:/project/story.mp3',
    ],
  );
});

test('workspaceFallbackForProjectRelativePath maps managed relative paths to workspace root', () => {
  assert.equal(
    workspaceFallbackForProjectRelativePath('./fichiers-importes/story.mp3', 'C:/workspace'),
    'C:/workspace/fichiers-importes/story.mp3',
  );
  assert.equal(
    workspaceFallbackForProjectRelativePath('../voix-generees/voice.wav', 'C:/workspace'),
    'C:/workspace/voix-generees/voice.wav',
  );
  assert.equal(
    workspaceFallbackForProjectRelativePath('./custom-assets/story.mp3', 'C:/workspace'),
    null,
  );
});

test('chooseCompatibleProjectPath prefers workspace media when the project-relative target is missing', () => {
  assert.equal(
    chooseCompatibleProjectPath(
      './fichiers-importes/story.mp3',
      'C:/workspace/sauvegardes/fichiers-importes/story.mp3',
      'C:/workspace',
      { projectExists: false, workspaceExists: true },
    ),
    'C:/workspace/fichiers-importes/story.mp3',
  );

  assert.equal(
    chooseCompatibleProjectPath(
      './fichiers-importes/story.mp3',
      'C:/workspace/sauvegardes/fichiers-importes/story.mp3',
      'C:/workspace',
      { projectExists: true, workspaceExists: true },
    ),
    'C:/workspace/sauvegardes/fichiers-importes/story.mp3',
  );
});
