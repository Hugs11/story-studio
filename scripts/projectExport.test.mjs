import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectData, projectToRustExport, projectToSerializable } from '../src/store/projectModel.js';
import {
  PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS,
  PACK_AUDIO_EDGE_SILENCE_SECONDS,
  normalizePackAudioEdgeSilence,
  parsePackAudioEdgeSilenceOverride,
  readPackAudioEdgeSilenceOverrides,
  resolvePackAudioEdgeSilence,
} from '../src/config/audioProcessing.js';

test('audio edge silence settings keep the supported range', () => {
  assert.equal(normalizePackAudioEdgeSilence(null), PACK_AUDIO_EDGE_SILENCE_SECONDS);
  assert.equal(normalizePackAudioEdgeSilence(-1), 0);
  assert.equal(normalizePackAudioEdgeSilence(2.5), 2.5);
  // Une préférence trop longue est bornée, comme une négative l'est à zéro.
  assert.equal(PACK_AUDIO_EDGE_SILENCE_MAX_SECONDS, 10);
  assert.equal(normalizePackAudioEdgeSilence(10), 10);
  assert.equal(normalizePackAudioEdgeSilence(99), 10);
  assert.equal(normalizePackAudioEdgeSilence('12'), 10);
});

test('les dérogations de durée acceptent zéro et la virgule, mais pas une saisie invalide', () => {
  assert.equal(parsePackAudioEdgeSilenceOverride(null), null);
  assert.equal(parsePackAudioEdgeSilenceOverride('0'), 0);
  assert.equal(parsePackAudioEdgeSilenceOverride('0,65'), 0.65);
  assert.equal(parsePackAudioEdgeSilenceOverride(' 1.25 '), 1.25);
  // Un champ vidé reprend la préférence : ce n'est pas une saisie invalide.
  assert.equal(parsePackAudioEdgeSilenceOverride(''), null);
  assert.equal(parsePackAudioEdgeSilenceOverride('   '), null);
  assert.equal(parsePackAudioEdgeSilenceOverride('10'), 10);
  assert.equal(parsePackAudioEdgeSilenceOverride('10,5'), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride(11), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride('abc'), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride('-0,1'), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride('0x10'), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride('1e3'), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride('1,2.3'), undefined);
  assert.equal(parsePackAudioEdgeSilenceOverride(Number.POSITIVE_INFINITY), undefined);
  assert.deepEqual(readPackAudioEdgeSilenceOverrides({
    leadingSilenceSec: '0,65',
    trailingSilenceSec: 'abc',
  }), {
    leadingSilenceSec: 0.65,
    trailingSilenceSec: null,
  });
});

test('les durées personnalisées héritent des préférences indépendamment par côté', () => {
  assert.deepEqual(resolvePackAudioEdgeSilence({
    leadingSilenceSec: '0,65',
    trailingSilenceSec: null,
  }, { leading: 1.2, trailing: 0.8 }), {
    leading: 0.65,
    trailing: 0.8,
  });
  assert.deepEqual(resolvePackAudioEdgeSilence({
    leadingSilenceSec: 'invalide',
    trailingSilenceSec: 0,
  }, { leading: 1.2, trailing: 0.8 }), {
    leading: 1.2,
    trailing: 0,
  });
});

test('projectToRustExport injects pack export metadata', () => {
  const project = normalizeProjectData({
    projectName: 'Example project',
    packMetadata: {
      title: 'Example stories',
      author: 'example_author',
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

  assert.equal(rustExport.name, '3+]Example_stories[by_example_author_V2');
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

test('projectToRustExport applique les dérogations du pack avant les préférences', () => {
  const project = normalizeProjectData({
    projectType: 'pack',
    globalOptions: { silenceMode: 'add', leadingSilenceSec: '0,25', trailingSilenceSec: null },
    rootEntries: [],
  });
  const rustExport = projectToRustExport(project, { leading: 1.2, trailing: 0.8 });

  assert.deepEqual(rustExport.globalOptions.addSilenceDurationSec, {
    start: 0.25,
    end: 0.8,
  });
});

test('une durée enregistrée avant le plafond est bornée à la relecture, jamais refusée', () => {
  // Un ancien `.mbah` peut porter 15 s : la relecture la ramène au plafond,
  // comme une préférence, au lieu de la jeter au profit de la préférence.
  assert.deepEqual(readPackAudioEdgeSilenceOverrides({
    leadingSilenceSec: 15,
    trailingSilenceSec: '12,5',
  }), {
    leadingSilenceSec: 10,
    trailingSilenceSec: 10,
  });
  const project = normalizeProjectData({
    projectType: 'pack',
    globalOptions: { silenceMode: 'add', leadingSilenceSec: 15, trailingSilenceSec: '' },
    rootEntries: [],
  });
  // La normalisation à l'ouverture borne la valeur et oublie le champ vide.
  assert.equal(project.globalOptions.leadingSilenceSec, 10);
  assert.equal(Object.hasOwn(project.globalOptions, 'trailingSilenceSec'), false);
  const rustExport = projectToRustExport(project, { leading: 1.2, trailing: 0.8 });
  assert.deepEqual(rustExport.globalOptions.addSilenceDurationSec, {
    start: 10,
    end: 0.8,
  });
});

test('projectToSerializable keeps Rust-only and legacy model fields out of the mbah model', () => {
  const serializable = projectToSerializable({
    projectName: 'Example project',
    packMetadata: { title: 'Example project', version: 1, minAge: '3' },
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
  assert.equal(Object.hasOwn(serializable.globalOptions, 'leadingSilenceSec'), false);
  assert.equal(Object.hasOwn(serializable.globalOptions, 'trailingSilenceSec'), false);
  assert.equal(Object.hasOwn(serializable, 'rootItems'), false);
  assert.equal(Object.hasOwn(serializable, 'menus'), false);
});

test('les dérogations valides survivent au round-trip .mbah et les invalides sont ignorées', async () => {
  const { encodeProjectFile, decodeProjectFile } = await import('../src/store/projectModel.js');
  const project = normalizeProjectData({
    projectType: 'pack',
    globalOptions: { leadingSilenceSec: '0,55', trailingSilenceSec: -1 },
    rootEntries: [],
  });

  assert.equal(project.globalOptions.leadingSilenceSec, 0.55);
  assert.equal(Object.hasOwn(project.globalOptions, 'trailingSilenceSec'), false);
  const reopened = await decodeProjectFile(encodeProjectFile(project));
  assert.equal(reopened.project.globalOptions.leadingSilenceSec, 0.55);
  assert.equal(Object.hasOwn(reopened.project.globalOptions, 'trailingSilenceSec'), false);
});

test('le codec .mbah avancé conserve les options de durée de son enveloppe', async () => {
  const { createAdvancedProject, encodeProjectFile, decodeProjectFile } = await import('../src/store/projectModel.js');
  const advanced = {
    ...createAdvancedProject({ payload: '{"payloadVersion":1,"document":{},"context":{} }' }),
    globalOptions: { leadingSilenceSec: 0.2, trailingSilenceSec: 0 },
  };
  const reopened = await decodeProjectFile(encodeProjectFile(advanced), {
    validateAdvancedPayload: async () => ({}),
  });

  assert.deepEqual(reopened.project.globalOptions, {
    leadingSilenceSec: 0.2,
    trailingSilenceSec: 0,
  });
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
    rootEntries: [{ id: 'story-1', type: 'story', name: 'Histoire', returnAfterPlay: 'story:shared-story' }],
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
