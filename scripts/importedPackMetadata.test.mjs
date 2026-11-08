import test from 'node:test';
import assert from 'node:assert/strict';
import { generateConventionName } from '../src/utils/packConvention.js';
import { resolveImportedPackMetadata } from '../src/store/importedPackMetadata.js';
import { buildProjectAfterZipUnpack, getUnpackedPackDetails } from '../src/store/unpackProject.js';
import { normalizeProjectData, projectToRustExport } from '../src/store/projectModel.js';
import { acquireCreatedAdvancedProject, acquireImportedAdvancedProject, createAdvancedProject, prepareImportedAdvancedProject } from '../src/store/projectModel/authoring.js';
import { encodeProjectFile, decodeProjectFile } from '../src/store/projectModel/codec.js';
import { advancedArchiveBaseName } from '../src/store/advancedExport/archiveName.js';
import { createProductionCommand } from '../src/store/production/productionRouting.js';
import { hasConfirmedFreeExportName } from '../src/store/projectHelpers.js';
import { advancedPackMetadataDraft, freePackRecap, packTitleBarName } from '../src/store/packMetadataModel.js';

const value = v => v == null ? { presence: 'absent' } : { presence: 'value', value: v };
const graph = () => createAdvancedProject({ payload: 'OPAQUE' });

for (const [label, pack, fileName, expected] of [
  ['complet', { title: '6+]Le_Renard[by_Auteur_V4', version: 4, description: 'Description' }, '/packs/source.zip', { title: 'Le Renard', minAge: '6', version: 4, author: 'Auteur', description: 'Description' }],
  ['sans titre', { version: 4 }, '/packs/6+]Le_Renard.zip', { title: 'Le Renard', minAge: '6', version: 4, author: '', description: '' }],
  ['sans âge', { title: 'Le Renard', version: 4 }, '/packs/source.7z', { title: 'Le Renard', minAge: '', version: 4, author: '', description: '' }],
  ['repli M1 avec convention du titre sans auteur', { title: '5+]Titre_V3', version: 3 }, '/packs/8+]Autre[by_Auteur_V9.zip', { title: 'Titre', minAge: '5', version: 3, author: '', description: '' }],
  ['sans version', { title: 'Le Renard' }, '/packs/source.zip', { title: 'Le Renard', minAge: '', version: 1, author: '', description: '' }],
  ['version invalide', { version: 0 }, '/packs/6+ Le Renard/', { title: 'Le Renard', minAge: '6', version: 1, author: '', description: '' }],
  ['titre prioritaire sur le nom', { title: 'Vrai titre', version: 4 }, '/packs/6+]Autre_titre.zip', { title: 'Vrai titre', minAge: '6', version: 4, author: '', description: '' }],
]) {
  test(`menus et graphe : ${label}`, async () => {
    const menus = getUnpackedPackDetails({ result: { title: pack.title, packVersion: pack.version, packDescription: pack.description }, zipPath: fileName }).packMetadata;
    const changes = [];
    const prepared = await prepareImportedAdvancedProject(graph(), {
      packPath: fileName,
      invokeCommand: async (command, args) => {
        if (command === 'read_advanced_graph_view') return { metadata: { title: value(pack.title), version: value(pack.version), description: value(pack.description) } };
        changes.push(args.gesture.update);
        return { payload: 'PREPARED', mediaBindings: [], report: {} };
      },
    });
    const graphMetadata = {
      ...prepared.packMetadata,
      title: changes[0].title?.value ?? pack.title,
      version: changes[0].version.value,
      description: pack.description ?? '',
    };
    for (const [key, wanted] of Object.entries(expected)) {
      assert.equal(menus[key], wanted, `menus ${key}`);
      assert.equal(graphMetadata[key], wanted, `graphe ${key}`);
    }
  });
}

test('la fiche complète chaque champ vide entre le pack et les replis M1', () => {
  const catalogue = { title: 'Fiche : été_2026', minAge: 7, maxAge: 10, author: 'Auteur fiche', description: 'Description fiche' };
  const fromCard = resolveImportedPackMetadata({ catalogue, fileName: '3+]Fichier[by_Fichier_V9.zip' });
  assert.equal(fromCard.title, 'Fiche : été_2026');
  assert.equal(fromCard.minAge, '7');
  assert.equal(fromCard.maxAge, undefined); // La fiche ne fournit jamais maxAge.
  assert.equal(fromCard.author, 'Auteur fiche');
  assert.equal(fromCard.description, 'Description fiche');
  const pack = { title: 'Pack', minAge: 0, maxAge: 12, author: 'Auteur pack', description: 'Description pack' };
  const kept = resolveImportedPackMetadata({ pack, catalogue, fileName: 'source.zip' });
  for (const key of Object.keys(pack)) assert.equal(String(kept[key]), String(pack[key]), key);
  assert.deepEqual(resolveImportedPackMetadata({ catalogue: { title: '', minAge: null, author: ' ', description: '' }, fileName: 'source.zip' }), resolveImportedPackMetadata({ fileName: 'source.zip' }));
});

for (const pack of [{}, { title: '8+]Pack[by_Auteur_pack_V1', description: 'Description pack' }]) {
  test(`menus et graphe avec fiche : ${pack.title || 'champs vides'}`, async () => {
    const catalogue = { title: 'Fiche', minAge: 7, maxAge: 12, author: 'Auteur fiche', description: 'Description fiche' };
    const menus = getUnpackedPackDetails({ result: { catalogueMetadata: catalogue, ...pack, packDescription: pack.description }, zipPath: 'source.zip' }).packMetadata;
    const updates = [];
    const prepared = await prepareImportedAdvancedProject(graph(), {
      catalogue, packPath: 'source.zip',
      invokeCommand: async (command, args) => {
        if (command === 'read_advanced_graph_view') return { metadata: { title: value(pack.title), description: value(pack.description) } };
        updates.push(args.gesture.update);
        return { payload: 'PREPARED', mediaBindings: [], report: {} };
      },
    });
    const update = updates[0];
    const advanced = { ...prepared.packMetadata, title: update.title?.value ?? pack.title, description: update.description?.value ?? pack.description };
    for (const field of ['title', 'minAge', 'maxAge', 'author', 'description']) assert.equal(advanced[field], menus[field], field);
    assert.equal(advancedArchiveBaseName({ packMetadata: advanced, title: advanced.title, version: advanced.version }), generateConventionName(menus));
  });
}

for (const editor of ['menus', 'graphe']) {
  test(`${editor} : projet vierge sans âge, sauvegarde et réouverture sans âge, ancien âge conservé`, async () => {
    const blank = editor === 'menus' ? normalizeProjectData({ projectType: 'pack' }) : await acquireCreatedAdvancedProject({ invokeCommand: async () => 'OPAQUE' });
    assert.equal(blank.packMetadata.minAge, '');
    for (const minAge of ['', '6']) {
      const source = { ...blank, packMetadata: { ...blank.packMetadata, minAge } };
      const { project: reopened } = await decodeProjectFile(encodeProjectFile(source), { validateAdvancedPayload: async () => ({}) });
      assert.equal(reopened.packMetadata.minAge, minAge);
    }
    const missing = { ...blank, packMetadata: { ...blank.packMetadata } };
    delete missing.packMetadata.minAge;
    const { project: reopened } = await decodeProjectFile(encodeProjectFile(missing), { validateAdvancedPayload: async () => ({}) });
    assert.equal(reopened.packMetadata.minAge ?? '', '');
  });

  test(`${editor} : import → nom libre → sauvegarde → réouverture → génération sans fiche imposée`, async () => {
    const metadata = { ...resolveImportedPackMetadata({ pack: { title: 'Titre', version: 4 }, fileName: '6+]Source.zip' }), namingMode: 'legacy', legacyExportName: 'Mon export', minAge: '' };
    const imported = editor === 'menus' ? normalizeProjectData({ projectType: 'pack', packMetadata: metadata }) : { ...graph(), packMetadata: metadata };
    const { project } = await decodeProjectFile(encodeProjectFile(imported), { validateAdvancedPayload: async () => ({}) });
    assert.equal(project.packMetadata.namingMode, 'legacy');
    assert.equal(project.packMetadata.legacyExportName, 'Mon export');
    assert.equal(project.packMetadata.minAge, '');
    assert.equal(hasConfirmedFreeExportName(project), true);
    const calls = [];
    createProductionCommand({
      readWorkspaceMode: () => editor === 'menus' ? 'hierarchical' : 'advanced',
      readProject: () => project,
      startFree: () => calls.push('generate'),
      startAdvanced: () => calls.push('metadata'),
      startAdvancedDirect: () => calls.push('generate'),
    })();
    assert.deepEqual(calls, ['generate']);
    assert.equal(editor === 'menus' ? projectToRustExport(project, { leading: 0, trailing: 0 }).name : advancedArchiveBaseName({ packMetadata: project.packMetadata, title: 'Titre', version: 4 }), 'Mon export');
  });
}

test('bandeau : titre, titre effacé avec fichier, projet neuf sans titre', () => {
  assert.equal(packTitleBarName('Titre', 'Projet'), 'Titre');
  assert.equal(packTitleBarName('', 'Projet'), 'Projet');
  assert.equal(packTitleBarName('', ''), ''); // TitleBar traduit ensuite « Sans titre ».
  assert.equal(freePackRecap({ packMetadata: {} }, 'pack').line, 'v1');
  assert.equal(advancedPackMetadataDraft({ metadata: {} }).title, '');
});

for (const zipPath of ['/cache/a1b2c3.zip', '/cache/member-2.zip', '/cache/authorized-0123.zip']) {
  test(`nom visible prioritaire sur ${zipPath}, menus et graphe`, async () => {
    const zipName = '6+ Le Renard';
    const menus = getUnpackedPackDetails({ zipPath, zipName }).packMetadata;
    let title;
    const prepared = await prepareImportedAdvancedProject(graph(), {
      packPath: zipPath, packLabel: zipName,
      invokeCommand: async (command, args) => {
        if (command === 'read_advanced_graph_view') return { metadata: {} };
        title = args.gesture.update.title.value;
        return { payload: 'PREPARED', mediaBindings: [], report: {} };
      },
    });
    assert.equal(menus.title, 'Le Renard');
    assert.equal(menus.minAge, '6');
    assert.equal(title, 'Le Renard');
    assert.equal(prepared.packMetadata.minAge, '6');
  });
}

test('graphe : le nom libre ne saute la fiche qu’après réouverture', () => {
  const project = { packMetadata: { namingMode: 'legacy', legacyExportName: 'Mon export' } };
  for (const pending of [false, true]) {
    const calls = [];
    createProductionCommand({
      readWorkspaceMode: () => 'advanced', readProject: () => project,
      readImportedPackPendingMeta: () => pending,
      startAdvanced: () => calls.push('metadata'), startAdvancedDirect: () => calls.push('generate'),
    })();
    assert.deepEqual(calls, [pending ? 'metadata' : 'generate']);
  }
});

test('sans âge avec auteur : générer puis rouvrir dans les deux éditeurs', async () => {
  const { advancedStoryTitle } = await import('../src/store/advancedExport/archiveName.js');
  const { generateConventionName, parseConventionName } = await import('../src/utils/packConvention.js');
  const metadata = { title: 'Le Renard', author: 'Esope', minAge: '', version: 2, namingMode: 'convention' };
  const menuName = projectToRustExport(normalizeProjectData({ projectType: 'pack', packMetadata: metadata }), { leading: 0, trailing: 0 }).name;
  const graphName = advancedStoryTitle({ packMetadata: metadata, title: metadata.title, version: 2 });
  assert.equal(menuName, 'Le_Renard[by_Esope_V2');
  assert.equal(graphName, menuName);
  const parsed = parseConventionName(menuName);
  assert.equal(parsed.author, 'Esope');
  assert.equal(parsed.title, 'Le Renard');
  assert.equal(parsed.version, 2);
  assert.equal(parsed.minAge, '');
  for (const name of [menuName, graphName]) {
    const menus = getUnpackedPackDetails({ result: { title: name }, zipName: `${name}.zip` }).packMetadata;
    let title;
    const prepared = await prepareImportedAdvancedProject(graph(), {
      packLabel: `${name}.zip`,
      invokeCommand: async (command, args) => {
        if (command === 'read_advanced_graph_view') return { metadata: { title: value(name) } };
        title = args.gesture.update.title.value;
        return { payload: 'PREPARED', mediaBindings: [], report: {} };
      },
    });
    assert.equal(title, menus.title);
    assert.equal(prepared.packMetadata.author, 'Esope');
    assert.equal(prepared.packMetadata.minAge, '');
    assert.equal(menus.version, 2);
    assert.equal(generateConventionName(menus), name);
  }
});

for (const [thumbnailImage, expected] of [[null, 'entry.png'], ['copied-catalogue.jpg', 'copied-catalogue.jpg'], ['pack-thumbnail.png', 'pack-thumbnail.png']]) {
  test(`promotion menus : vignette ${thumbnailImage || 'image entrée'}`, () => {
    const { project } = buildProjectAfterZipUnpack({
      project: normalizeProjectData({ projectType: 'pack' }), menuId: null,
      entries: [{ id: 'story', type: 'story', name: 'Histoire' }], zipPath: 'source.zip',
      result: { thumbnailImage, rootImage: 'entry.png', catalogueMetadata: { title: 'Fiche' } },
    });
    assert.equal(project.thumbnailImage, expected);
    assert.equal(project.sameImage, !thumbnailImage);
  });
}

test('graphe : valeurs de la commande consommées une fois sans entrer dans le .mbah', async () => {
  const acquired = await acquireImportedAdvancedProject({
    packPath: 'source.zip', assetsDir: '/workspace/assets', workspaceDir: '/workspace', catalogueMetadata: true,
    invokeCommand: async (command, args) => {
      assert.equal(command, 'acquire_advanced_pack_document');
      assert.equal(args.catalogueMetadata, true);
      return { payload: 'OPAQUE', mediaBindings: [], thumbnailImage: '/workspace/assets/copied.jpg', catalogueMetadata: { title: 'Fiche', minAge: 6, author: 'Auteur', description: 'Description' } };
    },
  });
  assert.equal(acquired.thumbnailImage, '/workspace/assets/copied.jpg');
  const updates = [];
  const invokeCommand = async (command, args) => {
    if (command === 'read_advanced_graph_view') return { metadata: {} };
    updates.push(args.gesture.update);
    return { payload: 'PREPARED', mediaBindings: [], report: {} };
  };
  const prepared = await prepareImportedAdvancedProject(acquired, { packPath: 'source.zip', invokeCommand });
  assert.equal(prepared.packMetadata.minAge, '6');
  assert.equal(updates[0].title.value, 'Fiche');
  assert.equal(updates[0].description.value, 'Description');
  assert.ok(!encodeProjectFile(prepared).includes('catalogueMetadata'));
  await prepareImportedAdvancedProject(acquired, { packPath: 'source.zip', invokeCommand });
  assert.equal(updates[1].title.value, 'source');
});

for (const editor of ['menus', 'graphe']) {
  test(`${editor} : rouvrir un .mbah conserve tous les champs vidés`, async () => {
    const source = editor === 'menus' ? normalizeProjectData({ projectType: 'pack' }) : graph();
    source.packMetadata = { ...source.packMetadata, title: '', minAge: '', author: '', description: '' };
    const { project } = await decodeProjectFile(encodeProjectFile(source), { validateAdvancedPayload: async () => ({}) });
    for (const field of ['title', 'minAge', 'author', 'description']) assert.equal(project.packMetadata[field] ?? '', '');
  });
}
