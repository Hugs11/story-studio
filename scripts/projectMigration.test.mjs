import test from 'node:test';
import assert from 'node:assert/strict';

import { migrateProjectData, normalizeProjectData, projectToRustExport, projectToSerializable } from '../src/store/projectModel.js';

test('legacy end message stays automatic while an explicit new setting is preserved', () => {
  const legacy = normalizeProjectData({ globalOptions: {}, rootEntries: [] });
  const waiting = normalizeProjectData({
    globalOptions: { endMessageAutoplay: false },
    rootEntries: [],
  });

  assert.equal(legacy.globalOptions.endMessageAutoplay, true);
  assert.equal(waiting.globalOptions.endMessageAutoplay, false);
  assert.equal(projectToRustExport(waiting).globalOptions.endMessageAutoplay, false);
});

test('migrates a legacy convention name to pack metadata', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }, { savePath: 'D:/packs/Mini-loup.mbah' }));

  assert.equal(migrated.projectName, 'Mini-loup');
  assert.equal(migrated.packMetadata.title, 'Les histoires de Mini-loup');
  assert.equal(migrated.packMetadata.author, 'funkyfoenky');
  assert.equal(migrated.packMetadata.version, 2);
  assert.equal(migrated.packMetadata.namingMode, 'convention');
});

test('migrates a legacy non convention name without changing export mode', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: 'Mon pack perso',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(migrated.projectName, 'Mon pack perso');
  assert.equal(migrated.packMetadata.title, 'Mon pack perso');
  assert.equal(migrated.packMetadata.namingMode, 'legacy');
  assert.equal(migrated.packMetadata.legacyExportName, 'Mon pack perso');
});

test('legacy fields enrich pack metadata', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: '3+]Mini_loup',
    packVersion: 4,
    packDescription: 'Changelog',
    packMinAge: '5',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(migrated.packMetadata.version, 4);
  assert.equal(migrated.packMetadata.description, 'Changelog');
  assert.equal(migrated.packMetadata.minAge, '5');
});

test('legacy convention without savePath keeps projectName local fallback', () => {
  const migrated = normalizeProjectData(migrateProjectData({
    name: '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2',
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  }));

  assert.equal(migrated.projectName, 'nouveau-projet');
  assert.equal(migrated.packMetadata.title, 'Les histoires de Mini-loup');
});

test('new structure remains idempotent', () => {
  const source = {
    schemaVersion: 3,
    projectName: 'Mini-loup',
    packMetadata: { title: 'Mini-loup', version: 2, minAge: '3' },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  };
  const migrated = normalizeProjectData(migrateProjectData(source, { savePath: 'D:/other/path.mbah' }));

  assert.equal(migrated.projectName, 'Mini-loup');
  assert.equal(migrated.packMetadata.title, 'Mini-loup');
  assert.equal(migrated.packMetadata.version, 2);
});

test('rust export injects pack metadata without legacy model fields', () => {
  const project = normalizeProjectData({
    projectName: 'Mini-loup',
    packMetadata: {
      title: 'Les histoires de Mini-loup',
      author: 'funkyfoenky',
      version: 2,
      minAge: '3',
      description: 'Changelog',
    },
    projectType: 'pack',
    globalOptions: {},
    rootEntries: [],
  });
  const serializable = projectToSerializable(project);
  const rustExport = projectToRustExport(project);

  assert.equal(Object.hasOwn(serializable, 'name'), false);
  assert.equal(Object.hasOwn(serializable, 'packVersion'), false);
  assert.equal(Object.hasOwn(serializable, 'rootItems'), false);
  assert.equal(Object.hasOwn(serializable, 'menus'), false);
  assert.equal(rustExport.name, '3+]Les_histoires_de_Mini-loup[by_funkyfoenky_V2');
  assert.equal(rustExport.packVersion, 2);
  assert.equal(rustExport.packDescription, 'Changelog');
  assert.equal(Object.hasOwn(rustExport, 'rootItems'), false);
  assert.equal(Object.hasOwn(rustExport, 'menus'), false);
});

test('legacy rootItems and menus migrate to rootEntries only', () => {
  const project = normalizeProjectData(migrateProjectData({
    name: 'Legacy pack',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [{ id: 'root-story', type: 'story', name: 'Root story' }],
    menus: [{
      id: 'menu-one',
      name: 'Menu one',
      audio: 'menu.mp3',
      image: 'menu.png',
      items: [{ id: 'child-story', type: 'story', name: 'Child story' }],
    }],
  }));

  assert.equal(Object.hasOwn(project, 'rootItems'), false);
  assert.equal(Object.hasOwn(project, 'menus'), false);
  assert.equal(project.rootEntries.length, 2);
  assert.equal(project.rootEntries[0].id, 'root-story');
  assert.equal(project.rootEntries[1].children[0].id, 'child-story');
});

test('rust export preserves legacy raw name', () => {
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

test('V1 fixture with rootItems + menus normalises to clean rootEntries only', () => {
  const v1 = {
    // pas de schemaVersion — fixture historique V1
    name: 'Pack legacy V1',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [
      { id: 'root-story', type: 'story', name: 'Histoire racine', audio: 'root.mp3' },
    ],
    menus: [
      {
        id: 'menu-1',
        name: 'Menu A',
        audio: 'menu-a.mp3',
        image: 'menu-a.png',
        items: [
          { id: 'story-a1', type: 'story', name: 'A1', audio: 'a1.mp3' },
          { id: 'story-a2', type: 'story', name: 'A2', audio: 'a2.mp3' },
        ],
      },
    ],
  };

  const project = normalizeProjectData(migrateProjectData(v1));

  assert.equal(Object.hasOwn(project, 'rootItems'), false);
  assert.equal(Object.hasOwn(project, 'menus'), false);
  assert.equal(project.rootEntries.length, 2);
  assert.equal(project.rootEntries[0].id, 'root-story');
  assert.equal(project.rootEntries[1].id, 'menu-1');
  assert.equal(project.rootEntries[1].children.length, 2);
  assert.equal(project.rootEntries[1].children[0].id, 'story-a1');
});

test('V2 fixture with explicit schemaVersion 2 and legacy fields normalises identically', () => {
  const v2 = {
    schemaVersion: 2,
    name: 'Pack legacy V2',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [],
    menus: [
      {
        id: 'menu-v2',
        name: 'Menu V2',
        audio: 'menu-v2.mp3',
        image: 'menu-v2.png',
        items: [
          { id: 'story-v2', type: 'story', name: 'Histoire V2', audio: 'story.mp3' },
        ],
      },
    ],
  };

  const project = normalizeProjectData(migrateProjectData(v2));

  assert.equal(Object.hasOwn(project, 'rootItems'), false);
  assert.equal(Object.hasOwn(project, 'menus'), false);
  assert.equal(project.rootEntries.length, 1);
  assert.equal(project.rootEntries[0].id, 'menu-v2');
  assert.equal(project.rootEntries[0].children[0].id, 'story-v2');
});

test('legacy controlSettings on a story migrate to the current full shape with defaults', () => {
  const v1 = {
    name: 'Pack legacy controlSettings',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [
      {
        id: 'story-legacy-cs',
        type: 'story',
        name: 'Histoire avec controlSettings legacy',
        audio: 'legacy.mp3',
        // Forme legacy : un seul champ posé, les autres doivent fallback aux defaults story.
        controlSettings: { autoplay: true },
      },
    ],
    menus: [],
  };

  const project = normalizeProjectData(migrateProjectData(v1));
  const story = project.rootEntries[0];

  assert.equal(story.id, 'story-legacy-cs');
  assert.equal(story.controlSettings.autoplay, true);
  assert.equal(story.controlSettings.wheel, false);
  assert.equal(story.controlSettings.pause, true);
  assert.equal(story.controlSettings.ok, false);
  assert.equal(story.controlSettings.home, true);
});

test('schemaVersion is set to 3 after migration', () => {
  const migrated = migrateProjectData({
    name: 'Pack legacy',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [],
    menus: [],
  });

  assert.equal(migrated.schemaVersion, 3);
});

test('legacy default end node name is renamed to message de fin', () => {
  const project = normalizeProjectData({
    projectType: 'pack',
    projectName: 'Pack',
    endNodeName: 'Nœud de fin',
    rootEntries: [],
  });

  assert.equal(project.endNodeName, 'Message de fin');
});

test('V1 → normalize → re-serialize → re-normalize is idempotent', () => {
  const v1 = {
    name: 'Pack legacy round trip',
    projectType: 'pack',
    globalOptions: {},
    rootItems: [
      { id: 'story-rt', type: 'story', name: 'Histoire RT', audio: 'rt.mp3' },
    ],
    menus: [
      {
        id: 'menu-rt',
        name: 'Menu RT',
        audio: 'menu-rt.mp3',
        image: 'menu-rt.png',
        items: [{ id: 'story-rt-child', type: 'story', name: 'Enfant RT', audio: 'rt-child.mp3' }],
      },
    ],
  };

  const first = normalizeProjectData(migrateProjectData(v1));
  const serialised = projectToSerializable(first);
  const second = normalizeProjectData(serialised);

  assert.equal(second.schemaVersion, 3);
  assert.equal(Object.hasOwn(second, 'rootItems'), false);
  assert.equal(Object.hasOwn(second, 'menus'), false);
  assert.equal(second.rootEntries.length, first.rootEntries.length);
  assert.equal(second.rootEntries[0].id, first.rootEntries[0].id);
  assert.equal(second.rootEntries[1].id, first.rootEntries[1].id);
  assert.equal(second.rootEntries[1].children[0].id, first.rootEntries[1].children[0].id);
  assert.equal(second.projectType, first.projectType);
  assert.equal(second.packMetadata.title, first.packMetadata.title);
  assert.equal(second.packMetadata.version, first.packMetadata.version);
});
