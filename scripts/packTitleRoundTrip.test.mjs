// Le titre d'un pack dans les deux éditeurs : la fiche montre le titre lisible,
// l'archive porte la convention avec l'âge (`story.json` `title`), et un
// aller-retour « ouvrir → générer → rouvrir » ne double jamais l'âge, l'auteur
// ni la version.
//
// Tout est pur : le moteur est simulé par ce qu'il rend réellement — la vue du
// document pour l'import graphe, le titre écrit dans `story.json` pour l'export.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  advancedArchiveBaseName,
  advancedStoryTitle,
} from '../src/store/advancedExport/archiveName.js';
import { buildExportRequest } from '../src/store/advancedExport/exportRequest.js';
import { prepareImportedAdvancedProject } from '../src/store/projectModel/authoring.js';
import { normalizeProjectData, projectToRustExport } from '../src/store/projectModel.js';
import { getUnpackedPackDetails } from '../src/store/unpackProject.js';
import { generateConventionName } from '../src/utils/packConvention.js';

const EDGE = { leading: 0, trailing: 0 };

// ── La convention ne se compose qu'une fois ─────────────────────────────────

for (const [label, title, metadata, expected] of [
  ['âge seul', '3+]Le_Renard', { minAge: '3', version: 2 }, '3+]Le_Renard_V2'],
  ['âge et version', '3+]Le_Renard_V5', { minAge: '3', version: 6 }, '3+]Le_Renard_V6'],
  ['autre âge', '5+]Le_Renard_V5', { minAge: '5', version: 6 }, '5+]Le_Renard_V6'],
  ['auteur et version', '3+]Le_Renard[by_Ésope_V5', { minAge: '3', author: 'Ésope', version: 6 }, '3+]Le_Renard[by_Ésope_V6'],
  ['auteur non ressaisi', '3+]Le_Renard[by_Ésope_V5', { minAge: '3', version: 6 }, '3+]Le_Renard[by_Ésope_V6'],
  ['version au tiret', '3+]Le_Renard[by_Ésope-V5', { minAge: '3', version: 6 }, '3+]Le_Renard[by_Ésope_V6'],
]) {
  test(`un titre qui porte déjà la convention n'est pas recomposé deux fois (${label})`, () => {
    const name = generateConventionName({ ...metadata, title });
    assert.equal(name, expected);
    assert.doesNotMatch(name, /\d\+\].*\d\+\]/);
    assert.doesNotMatch(name, /_V\d+_V\d+/);
  });
}

// ── Import graphe : le titre lisible, l'âge dans les champs de nommage ──────

function graphImportInvoker(title, calls, version = 5) {
  return async (command, args) => {
    calls.push({ command, args });
    if (command === 'read_advanced_graph_view') {
      return {
        metadata: {
          title: title == null ? { presence: 'absent' } : { presence: 'value', value: title },
          version: { presence: 'value', value: version },
        },
        opaqueMembers: [],
      };
    }
    return { payload: 'DOC', mediaBindings: [], report: {} };
  };
}

const importedGraph = () => ({
  schemaVersion: 4,
  authoringMode: 'advanced',
  projectType: 'advanced',
  projectName: 'pack',
  rootEntries: [],
  authoring: { payload: 'DOC', editorState: { version: 1 }, mediaBindings: [] },
});

function metadataGestures(calls) {
  return calls
    .filter((call) => call.command === 'apply_advanced_gesture'
      && call.args.gesture.gesture === 'set-document-metadata')
    .map((call) => call.args.gesture.update);
}

test('import graphe d’un pack au titre de convention : la fiche reçoit le titre lisible', async () => {
  const calls = [];
  const prepared = await prepareImportedAdvancedProject(importedGraph(), {
    invokeCommand: graphImportInvoker('3+]Le_Renard[by_Ésope_V5', calls),
    packPath: 'C:/packs/3+]Le_Renard[by_Ésope_V5.zip',
  });
  const titles = metadataGestures(calls).map((update) => update.title).filter(Boolean);
  assert.deepEqual(titles, [{ form: 'set', value: 'Le Renard' }]);
  assert.equal(prepared.packMetadata.namingMode, 'convention');
  assert.equal(prepared.packMetadata.minAge, '3');
  assert.equal(prepared.packMetadata.author, 'Ésope');
});

test('import graphe d’un pack au titre libre : le titre reste tel quel, le nommage passe en convention', async () => {
  const calls = [];
  const prepared = await prepareImportedAdvancedProject(importedGraph(), {
    invokeCommand: graphImportInvoker('Les histoires du soir', calls),
    packPath: 'C:/packs/histoires.zip',
  });
  const titles = metadataGestures(calls).map((update) => update.title).filter(Boolean);
  assert.deepEqual(titles, []);
  assert.equal(prepared.packMetadata.namingMode, 'convention');
  assert.equal(prepared.packMetadata.minAge, '');
});

test('import graphe et import par menus donnent la même fiche', async () => {
  for (const [title, zipPath] of [
    ['3+]Le_Renard[by_Ésope_V5', 'C:/packs/3+]Le_Renard[by_Ésope_V5.zip'],
    ['5+]Le_Renard_V2', 'C:/packs/renard.zip'],
    ['Les histoires du soir', 'C:/packs/histoires.zip'],
  ]) {
    const calls = [];
    const prepared = await prepareImportedAdvancedProject(importedGraph(), {
      invokeCommand: graphImportInvoker(title, calls),
      packPath: zipPath,
    });
    const graphTitle = metadataGestures(calls).find((update) => update.title)?.title?.value ?? title;
    const menus = getUnpackedPackDetails({ result: { title, packVersion: 5 }, zipPath }).packMetadata;
    assert.equal(graphTitle, menus.title, title);
    for (const field of ['minAge', 'author', 'producer', 'bonus', 'namingMode']) {
      assert.equal(prepared.packMetadata[field], menus[field], `${title} : ${field}`);
    }
  }
});

// ── Export graphe : `story.json` porte la convention, sauf nom libre ────────

test('export graphe en convention : le titre de story.json est le nom de convention', () => {
  const naming = { namingMode: 'convention', minAge: '3', author: 'Ésope' };
  const storyTitle = advancedStoryTitle({ packMetadata: naming, title: 'Le Renard', version: 6 });
  assert.equal(storyTitle, '3+]Le_Renard[by_Ésope_V6');
  assert.equal(storyTitle, advancedArchiveBaseName({ packMetadata: naming, title: 'Le Renard', version: 6 }));
  const request = buildExportRequest({
    project: { ...importedGraph(), packMetadata: naming },
    outputFolder: 'C:/sortie',
    storyTitle,
  });
  assert.equal(request.storyTitle, '3+]Le_Renard[by_Ésope_V6');
});

test('export graphe en nom libre : story.json garde le titre du document', () => {
  for (const packMetadata of [null, {}, { namingMode: 'legacy', legacyExportName: 'mon-pack' }]) {
    assert.equal(advancedStoryTitle({ packMetadata, title: 'Le Renard', version: 6 }), '');
  }
  const request = buildExportRequest({
    project: importedGraph(),
    outputFolder: 'C:/sortie',
    storyTitle: '',
  });
  assert.equal('storyTitle' in request, false);
});

// ── Aller-retour : trois cycles par éditeur ──────────────────────────────────

// Ce que l'éditeur par menus écrit dans `story.json` : le `name` exporté.
function menusCycle(storyTitle, version, zipPath) {
  const { packMetadata } = getUnpackedPackDetails({ result: { title: storyTitle, packVersion: version }, zipPath });
  const project = normalizeProjectData({
    projectType: 'pack',
    projectName: 'pack',
    packMetadata,
    rootEntries: [],
  });
  return {
    fiche: project.packMetadata.title,
    produced: projectToRustExport(project, EDGE).name,
    version: project.packMetadata.version,
  };
}

// Ce que l'éditeur graphe écrit : le titre de convention transmis au moteur.
async function graphCycle(storyTitle, version, zipPath) {
  const calls = [];
  const prepared = await prepareImportedAdvancedProject(importedGraph(), {
    invokeCommand: graphImportInvoker(storyTitle, calls, version),
    packPath: zipPath,
  });
  const updates = metadataGestures(calls);
  const fiche = updates.find((update) => update.title)?.title?.value ?? storyTitle;
  const nextVersion = metadataGestures(calls)[0].version.value;
  return {
    fiche,
    produced: advancedStoryTitle({ packMetadata: prepared.packMetadata, title: fiche, version: nextVersion }),
    version: nextVersion,
  };
}

for (const [label, start, startVersion, readable] of [
  ['convention avec auteur', '3+]Le_Renard[by_Ésope_V5', 5, 'Le Renard'],
  ['convention sans auteur, autre âge', '5+]Le_Renard_V5', 5, 'Le Renard'],
  ['titre libre', 'Les histoires du soir', 1, 'Les histoires du soir'],
  ['titre libre', 'Le_Renard_V3', 3, 'Le Renard'],
  ['titre libre', 'Le Renard V3', 3, 'Le Renard'],
]) {
  for (const [editor, cycle] of [['menus', menusCycle], ['graphe', graphCycle]]) {
    test(`aller-retour ${editor}, ${label} : fiche lisible, âge posé une seule fois`, async () => {
      let title = start;
      let version = startVersion;
      const seen = [];
      for (let round = 0; round < 3; round += 1) {
        const zipPath = `C:/packs/cycle-${round}.zip`;
        const result = await cycle(title, version, zipPath);
        seen.push(result);
        assert.equal(result.fiche, readable, `cycle ${round + 1} : fiche`);
        assert.equal((result.produced.match(/\d\+\]/g) ?? []).length, label === 'titre libre' ? 0 : 1);
        assert.equal((result.produced.match(/_V\d+/g) ?? []).length, startVersion > 1 ? 1 : 0);
        assert.equal(result.version, startVersion);
        assert.doesNotMatch(result.produced, /Ésope.*Ésope/);
        title = result.produced;
        version = result.version;
      }
      assert.equal(seen[1].produced.replace(/_V\d+$/, ''), seen[2].produced.replace(/_V\d+$/, ''));
    });
  }
}

for (const [editor, cycle] of [['menus', menusCycle], ['graphe', graphCycle]]) {
  test(`${editor} : Mission V2 en version 5 conserve son suffixe de titre sur trois cycles`, async () => {
    let title = 'Mission V2';
    for (let round = 0; round < 3; round += 1) {
      const result = await cycle(title, 5, `C:/packs/mission-${round}.zip`);
      assert.equal(result.fiche, 'Mission V2');
      assert.equal(result.produced, 'Mission_V2_V5');
      assert.equal(result.version, 5);
      title = result.produced;
    }
  });
}

test('les deux éditeurs produisent le même titre d’archive pour le même pack', async () => {
  for (const start of ['3+]Le_Renard[by_Ésope_V5', '5+]Le_Renard_V5', 'Les histoires du soir']) {
    const menus = menusCycle(start, 5, 'C:/packs/a.zip');
    const graph = await graphCycle(start, 5, 'C:/packs/a.zip');
    assert.equal(graph.fiche, menus.fiche, start);
    assert.equal(graph.produced, menus.produced, start);
  }
});

// ── Nouveau projet graphe : convention par défaut ───────────────────────────

test('un nouveau projet graphe est en convention sans âge inventé', async () => {
  const { acquireCreatedAdvancedProject } = await import('../src/store/projectModel/authoring.js');
  const project = await acquireCreatedAdvancedProject({
    title: 'Le Renard',
    invokeCommand: async () => 'DOC',
  });
  assert.equal(project.packMetadata.namingMode, 'convention');
  const storyTitle = advancedStoryTitle({ packMetadata: project.packMetadata, title: 'Le Renard', version: 1 });
  assert.equal(project.packMetadata.minAge, '');
  assert.equal(storyTitle, 'Le_Renard');
  assert.equal(advancedArchiveBaseName({ packMetadata: project.packMetadata, title: 'Le Renard', version: 1 }), storyTitle);
  // Aller-retour : regénérer depuis le titre déjà composé ne double rien.
  assert.equal(advancedStoryTitle({ packMetadata: project.packMetadata, title: storyTitle, version: 2 }), 'Le_Renard_V2');
});

test('un nouveau projet graphe sans titre reste sans nom composé', async () => {
  const { acquireCreatedAdvancedProject } = await import('../src/store/projectModel/authoring.js');
  const project = await acquireCreatedAdvancedProject({ invokeCommand: async () => 'DOC' });
  assert.equal(advancedStoryTitle({ packMetadata: project.packMetadata, title: '', version: 1 }), '');
});

test('un titre de convention réduit à l’âge prend le nom de l’archive, dans les deux éditeurs', async () => {
  const zipPath = 'C:/packs/Les histoires du soir.zip';
  const menus = getUnpackedPackDetails({ result: { title: '6+] ', packVersion: 1 }, zipPath }).packMetadata;
  assert.equal(menus.title, 'Les histoires du soir');
  assert.equal(menus.minAge, '6');

  const calls = [];
  const prepared = await prepareImportedAdvancedProject(importedGraph(), {
    invokeCommand: graphImportInvoker('6+] ', calls),
    packPath: zipPath,
  });
  const titles = metadataGestures(calls).map((update) => update.title).filter(Boolean);
  assert.deepEqual(titles, [{ form: 'set', value: 'Les histoires du soir' }]);
  assert.equal(prepared.packMetadata.minAge, '6');
});
