import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isLocalAudioPath,
  versionLocalAssetUrl,
} from '../src/utils/localMediaAsset.js';

test('local audio paths are detected independently of spaces, accents, and case', () => {
  assert.equal(isLocalAudioPath('/tmp/Médias été/Voix Finale.FLAC'), true);
  assert.equal(isLocalAudioPath('D:\\Projet Test\\AUDIO.MP3'), true);
  assert.equal(isLocalAudioPath('/tmp/image.flac.png'), false);
  assert.equal(isLocalAudioPath('/tmp/sans-extension'), false);
});

test('asset URL versions preserve the path and escape metadata', () => {
  assert.equal(
    versionLocalAssetUrl('asset://localhost/tmp/Voix%20%C3%A9t%C3%A9.flac', '42:12 345'),
    'asset://localhost/tmp/Voix%20%C3%A9t%C3%A9.flac?v=42%3A12%20345',
  );
  assert.equal(
    versionLocalAssetUrl('https://asset.localhost/C%3A%5CVoix.flac?source=local', '2'),
    'https://asset.localhost/C%3A%5CVoix.flac?source=local&v=2',
  );
});
