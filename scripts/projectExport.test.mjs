import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectData, projectToRustExport, projectToSerializable } from '../src/store/projectModel.js';
import {
  PACK_AUDIO_EDGE_SILENCE_SECONDS,
  normalizePackAudioEdgeSilence,
} from '../src/config/audioProcessing.js';

test('audio edge silence settings keep the supported range', () => {
  assert.equal(normalizePackAudioEdgeSilence(null), PACK_AUDIO_EDGE_SILENCE_SECONDS);
  assert.equal(normalizePackAudioEdgeSilence(-1), 0);
  assert.equal(normalizePackAudioEdgeSilence(2.5), 2.5);
  assert.equal(normalizePackAudioEdgeSilence(99), 99);
});

test('projectToRustExport injects pack export metadata', () => {
  const project = normalizeProjectData({
    projectName: 'Mini-loup',
    packMetadata: {
      title: 'Les histoires de Mini-loup',
      author: 'funkyfoenky',
      version: 2,
      minAge: '3',
      description: 'Changelog',
      uuid: '11111111-2222-4333-8444-555555555555',
    },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  });

  const rustExport = projectToRustExport(project);

  assert.equal(rustExport.name, '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2');
  assert.equal(rustExport.packVersion, 2);
  assert.equal(rustExport.packDescription, 'Changelog');
  assert.equal(rustExport.packUuid, '11111111-2222-4333-8444-555555555555');
  assert.equal(rustExport.globalOptions.silenceMode, 'normalize');
  assert.deepEqual(rustExport.globalOptions.addSilenceDurationSec, {
    start: PACK_AUDIO_EDGE_SILENCE_SECONDS,
    end: PACK_AUDIO_EDGE_SILENCE_SECONDS,
  });
  assert.equal(Object.hasOwn(rustExport.globalOptions, 'convertFormat'), false);
  assert.equal(Object.hasOwn(rustExport, 'rootItems'), false);
  assert.equal(Object.hasOwn(rustExport, 'menus'), false);
});

test('projectToRustExport sends independent leading and trailing silence durations', () => {
  const rustExport = projectToRustExport({
    projectType: 'pack',
    globalOptions: { silenceMode: 'add' },
    rootEntries: [],
  }, {
    leading: 0.2,
    trailing: 0.7,
  });

  assert.deepEqual(rustExport.globalOptions.addSilenceDurationSec, {
    start: 0.2,
    end: 0.7,
  });
});

test('projectToSerializable keeps Rust-only and legacy model fields out of the mbah model', () => {
  const serializable = projectToSerializable({
    projectName: 'Mini-loup',
    packMetadata: { title: 'Mini-loup', version: 1, minAge: '3' },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  });

  assert.equal(Object.hasOwn(serializable, 'name'), false);
  assert.equal(Object.hasOwn(serializable, 'packVersion'), false);
  assert.equal(Object.hasOwn(serializable, 'packDescription'), false);
  assert.equal(serializable.globalOptions.silenceMode, 'normalize');
  assert.equal(Object.hasOwn(serializable.globalOptions, 'convertFormat'), false);
  assert.equal(Object.hasOwn(serializable.globalOptions, 'addSilence'), false);
  assert.equal(Object.hasOwn(serializable.globalOptions, 'addSilenceDurationSec'), false);
  assert.equal(Object.hasOwn(serializable, 'rootItems'), false);
  assert.equal(Object.hasOwn(serializable, 'menus'), false);
});

test('normalizeProjectData migrates legacy addSilence to silenceMode', () => {
  assert.equal(
    normalizeProjectData({ globalOptions: { addSilence: true } }).globalOptions.silenceMode,
    'add',
  );
  assert.equal(
    normalizeProjectData({ globalOptions: { addSilence: false } }).globalOptions.silenceMode,
    'off',
  );
});

test('projectToRustExport preserves a legacy raw export name', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Perso',
    packMetadata: {
      title: 'Mon pack perso',
      namingMode: 'legacy',
      legacyExportName: 'Mon pack perso',
    },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(rustExport.name, 'Mon pack perso');
});

test('projectToRustExport falls back to projectName for simple stories without packMetadata title', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Le loup et l agneau',
    packMetadata: { title: '', minAge: '3', version: 1 },
    projectType: 'simple',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(rustExport.name, '3+]Le_loup_et_l_agneau');
});

test('projectToRustExport keeps pack mode unaffected when title is empty', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Mon projet',
    packMetadata: { title: '', minAge: '3', version: 1 },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(rustExport.name, 'Story Studio');
});

test('projectToRustExport preserves an explicit silent title stage', () => {
  const rustExport = projectToRustExport(normalizeProjectData({
    projectName: 'Titre silencieux',
    packMetadata: { title: 'Titre silencieux', minAge: '3', version: 1 },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [{
      id: 'story-silent',
      type: 'story',
      name: 'Silencieuse',
      audio: 'story.mp3',
      itemAudio: null,
      itemImage: 'title.png',
      silentTitleStage: true,
      titleControlSettings: { autoplay: false, wheel: true, pause: false, ok: true, home: true },
    }],
  }));

  const story = rustExport.rootEntries[0];
  assert.equal(story.itemAudio, null);
  assert.equal(story.silentTitleStage, true);
  assert.deepEqual(story.titleControlSettings, {
    autoplay: false,
    wheel: true,
    pause: false,
    ok: true,
    home: true,
  });
});

test('projectToSerializable and projectToRustExport drop stale sharedEntries', () => {
  const project = normalizeProjectData({
    projectName: 'Partages',
    packMetadata: { title: 'Partages', minAge: '3', version: 1 },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [{ id: 'ref-1', type: 'ref', target: 'story:shared-story' }],
    sharedEntries: [
      {
        id: 'shared-story',
        type: 'story',
        name: 'Scene commune',
        audio: 'shared.mp3',
        itemAudio: 'shared-title.mp3',
        itemImage: 'shared.png',
      },
    ],
  });

  const serializable = projectToSerializable(project);
  const rustExport = projectToRustExport(project);

  assert.equal(Object.hasOwn(project, 'sharedEntries'), false);
  assert.equal(Object.hasOwn(serializable, 'sharedEntries'), false);
  assert.equal(Object.hasOwn(rustExport, 'sharedEntries'), false);
});
