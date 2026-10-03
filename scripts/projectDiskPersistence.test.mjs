// Enregistrement et réouverture sur disque.
//
// Les fichiers sont écrits dans un répertoire temporaire réel et relus par
// `node:fs`, jamais par la fonction qui vient de les écrire. Seuls les
// dialogues et le transport IPC sont doublés : `validate_advanced_payload`
// n'est pas déclaré au harnais, donc tout trajet exercé ici prouve, en passant,
// qu'il n'appelle pas Rust. Le cycle complet du mode Avancé — celui qui
// traverse le codec Rust — est éprouvé par `projectDiskTransport.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const io = await import('../src/store/projectIO.js');
const { normalizeProjectData, readProjectEnvelope } = await import('../src/store/projectModel.js');
const { KEYS } = await import('../src/store/persistentSettings.js');
const { normalizeWindowsPath } = await import('../src/utils/fileUtils.js');
const { collectMediaLibrary } = await import('../src/store/mediaLibrary.js');
const { createMediaTagLookup, withMediaTag } = await import('../src/store/mediaTags.js');

// Les champs médias racines (`rootAudio`, `rootImage`, `thumbnailImage`,
// `nightModeAudio`) sont rendus par `normalizeProjectData` dans la forme
// canonique de la plateforme : antislashs derrière une lettre de lecteur sous
// Windows, inchangé ailleurs. Les autres chemins, eux, restent en `/`. Une
// attente écrite sur ces champs doit donc passer par le même normaliseur,
// sinon elle ne tient que sur les systèmes sans lettre de lecteur.
const rootMediaPath = (path) => normalizeWindowsPath(path);

// Entier au-delà de 2^53 et fraction : un payload d'auteur ne traverse jamais
// `JSON.parse` en JavaScript, et le fichier écrit doit le prouver à l'octet.
const PAYLOAD = '{"payloadVersion":1,"document":{"title":"Le renard","stageNodes":[{"uuid":"0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34","squareOne":true,"audio":"a1b2c3.mp3","image":"d4e5f6.png","duration":9007199254740993,"position":{"x":120.5,"y":-32769}}],"actionNodes":[{"id":"action-1","options":["0f9c2a41-1d3e-4a8b-9c77-2f5b6e10ab34"]}]},"context":{"documentOrigin":"imported-studio","defaultValueOrigin":"source-studio"}}';

function advancedProject(bindings) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'renard-avance',
    rootEntries: [],
    authoring: {
      payload: PAYLOAD,
      editorState: { version: 1, viewport: { x: 0, y: 0, zoom: 1 } },
      mediaBindings: bindings,
    },
  };
}

const simpleProject = () => normalizeProjectData({
  projectName: 'conte-simple',
  projectType: 'simple',
  rootEntries: [{ id: 'story-1', type: 'story', name: 'Le renard' }],
});

const refProject = () => normalizeProjectData({
  projectName: 'pack-a-refs',
  rootEntries: [
    { id: 'story-1', type: 'story', name: 'Partagée' },
    { id: 'menu-1', type: 'menu', name: 'Dossier', children: [{ id: 'ref-1', type: 'ref', target: 'story:story-1' }] },
  ],
});

const oracleProject = () => normalizeProjectData({
  projectName: 'projet-oracle',
  rootEntries: [{ id: 'story-1', type: 'story', name: 'Importée' }],
  nativeGraph: {
    preserveForRoundTrip: true,
    document: { title: 'Oracle', stageNodes: [{ uuid: 'stage-a' }], actionNodes: [] },
  },
});

async function withHarness(run) {
  const harness = await createDiskHarness();
  harness.settings.setItem(KEYS.WORKSPACE_DIR, harness.workspace);
  try {
    await run(harness);
  } finally {
    await harness.dispose();
  }
}

const readJson = async (path) => JSON.parse(await fs.readFile(path, 'utf8'));

test('les trois témoins Libre traversent enregistrement, relecture et Save As', async () => {
  await withHarness(async (harness) => {
    for (const [name, build] of [['simple', simpleProject], ['refs', refProject], ['oracle', oracleProject]]) {
      const projectDir = await harness.mkdirp(name);
      const savePath = `${projectDir}/${name}.mbah`;
      const saved = await io.saveProject(build(), savePath);
      assert.equal(saved.path, savePath);

      const written = await readJson(savePath);
      assert.equal(written.schemaVersion, 3, `${name} : un projet Libre reste en schéma 3`);
      assert.equal(written.authoringMode, 'free');
      assert.equal(Object.hasOwn(written, 'authoring'), false);
      assert.equal(readProjectEnvelope(written).authoringMode, 'free');

      const reopened = await io.loadProjectFromPath(savePath);
      assert.equal(reopened.summary, null, `${name} : aucun résumé de payload en Libre`);
      assert.deepEqual(reopened.data.rootEntries, build().rootEntries);
      assert.equal(Object.hasOwn(reopened.data, 'mediaTags'), false);
      assert.equal(Object.hasOwn(reopened.data, 'mediaLibraryPaths'), false);
      // Transformations Libre historiques, conservées par le raccord du codec :
      // le schéma est réécrit en 3, le mode explicité, `version` porté à 2 dès
      // qu'il y a un arbre, et l'identité d'enveloppe créée une seule fois.
      assert.equal(reopened.data.schemaVersion, 3);
      assert.equal(reopened.data.authoringMode, 'free');
      assert.equal(reopened.data.version, 2);
      assert.equal(written.packMetadata.uuid, '', `${name} : l'écriture ne fabrique aucune identité`);
      assert.match(reopened.data.packMetadata.uuid, /\S/, `${name} : la relecture en crée une`);
      await io.saveProject(reopened.data, savePath);
      assert.equal((await io.loadProjectFromPath(savePath)).data.packMetadata.uuid,
        reopened.data.packMetadata.uuid, `${name} : elle n'est ensuite plus renouvelée`);

      const copyDir = await harness.mkdirp(`${name}-copie`);
      harness.answerSave(`${copyDir}/${name}-copie.mbah`);
      const beforeCopy = await readJson(savePath);
      const copied = await io.saveProjectAs(reopened.data, savePath);
      assert.equal(copied.path, `${copyDir}/${name}-copie.mbah`);
      assert.deepEqual(await readJson(savePath), beforeCopy, `${name} : la source d'un Save As reste intacte`);
      const reopenedCopy = await io.loadProjectFromPath(copied.path);
      assert.deepEqual(reopenedCopy.data.rootEntries, reopened.data.rootEntries);
    }
    // Aucun de ces trajets n'a consulté Rust.
    assert.equal(harness.countCalls('validate_advanced_payload'), 0);
  });
});

test('un oracle nativeGraph et ses médias survivent au déplacement du dossier', async () => {
  await withHarness(async (harness) => {
    const projectDir = await harness.mkdirp('avant');
    await harness.writeFile('avant/medias/intro.mp3', 'audio');
    const project = oracleProject();
    project.rootAudio = `${projectDir}/medias/intro.mp3`;
    project.nativeGraph.document.stageNodes[0].audio = `${projectDir}/medias/intro.mp3`;
    const savePath = `${projectDir}/oracle.mbah`;
    await io.saveProject(project, savePath);

    const written = await readJson(savePath);
    assert.equal(written.rootAudio, './medias/intro.mp3');
    assert.equal(written.nativeGraph.document.stageNodes[0].audio, './medias/intro.mp3');

    await fs.rename(projectDir, harness.dir('apres'));
    const movedPath = harness.dir('apres/oracle.mbah');
    const reopened = await io.loadProjectFromPath(movedPath);
    assert.equal(reopened.data.rootAudio, rootMediaPath(harness.dir('apres/medias/intro.mp3')));
    assert.equal(reopened.data.nativeGraph.document.stageNodes[0].audio, harness.dir('apres/medias/intro.mp3'));
    assert.deepEqual(reopened.data.nativeGraph.document.title, 'Oracle');
    assert.equal(await harness.exists(harness.dir('avant')), false);
  });
});

test('le backup relu porte l’état précédent, pas l’état courant', async () => {
  await withHarness(async (harness) => {
    const projectDir = await harness.mkdirp('backup');
    const savePath = `${projectDir}/projet.mbah`;
    const first = simpleProject();
    first.rootName = 'Première version';
    await io.saveProject(first, savePath, null, { backupLimit: 3 });

    const second = simpleProject();
    second.rootName = 'Seconde version';
    await io.saveProject(second, savePath, null, { backupLimit: 3 });

    const backupDir = `${harness.workspace}/sauvegardes/versions-securite`;
    const backups = await fs.readdir(backupDir);
    assert.equal(backups.length, 1, 'un seul backup : celui pris avant la seconde écriture');
    assert.equal((await readJson(`${backupDir}/${backups[0]}`)).rootName, 'Première version');
    assert.equal((await readJson(savePath)).rootName, 'Seconde version');

    const reopenedBackup = await io.loadProjectFromPath(`${backupDir}/${backups[0]}`);
    assert.equal(reopenedBackup.data.rootName, 'Première version');
  });
});

test('une panne d’écriture ou de remplacement laisse le fichier précédent lisible et sans artefact', async () => {
  for (const cmd of ['plugin:fs|write_text_file', 'plugin:fs|rename']) {
    await withHarness(async (harness) => {
      const projectDir = await harness.mkdirp('panne');
      const savePath = `${projectDir}/projet.mbah`;
      const first = simpleProject();
      first.rootName = 'État valide';
      await io.saveProject(first, savePath);
      const before = await fs.readFile(savePath, 'utf8');

      harness.injectFailure({ cmd, match: 'projet.mbah', message: `panne ${cmd}` });
      const second = simpleProject();
      second.rootName = 'Jamais écrit';
      await assert.rejects(io.saveProject(second, savePath, null, { backupLimit: 2 }));

      assert.equal(await fs.readFile(savePath, 'utf8'), before, `${cmd} : octets du .mbah inchangés`);
      assert.equal((await io.loadProjectFromPath(savePath)).data.rootName, 'État valide');
      const leftovers = (await fs.readdir(projectDir)).filter((name) => name.includes('.tmp-'));
      assert.deepEqual(leftovers, [], `${cmd} : aucun temporaire laissé`);
      // Le backup est pris avant l'écriture : il conserve l'état valide, et
      // c'est ce qu'il faut préserver.
      const backups = await fs.readdir(`${harness.workspace}/sauvegardes/versions-securite`);
      assert.equal(backups.length, 1);
      assert.equal((await readJson(`${harness.workspace}/sauvegardes/versions-securite/${backups[0]}`)).rootName, 'État valide');
    });
  }
});

test('un fichier refusé n’est ni normalisé, ni réécrit, ni soumis à Rust', async () => {
  await withHarness(async (harness) => {
    const cases = [
      ['tronque.mbah', '{"schemaVersion":3,"projectName":"cou', 'INVALID_PROJECT_JSON'],
      ['futur.mbah', JSON.stringify({ schemaVersion: 99, authoringMode: 'free' }), 'UNSUPPORTED_SCHEMA_VERSION'],
      ['contradictoire.mbah', JSON.stringify({ schemaVersion: 3, authoringMode: 'advanced' }), 'CONTRADICTORY_PROJECT_ENVELOPE'],
      ['sans-mode.mbah', JSON.stringify({ schemaVersion: 4, authoring: { payload: '{}', mediaBindings: [] } }), 'MISSING_AUTHORING_MODE'],
      ['bloc-absent.mbah', JSON.stringify({ schemaVersion: 4, authoringMode: 'advanced' }), 'CONTRADICTORY_PROJECT_ENVELOPE'],
    ];
    for (const [name, contents, code] of cases) {
      const path = await harness.writeFile(`refus/${name}`, contents);
      await assert.rejects(io.loadProjectFromPath(path), (error) => {
        assert.equal(error.code, code, name);
        assert.equal(error.fileName, name, 'le refus nomme le fichier');
        return true;
      });
      assert.equal(await fs.readFile(path, 'utf8'), contents, `${name} : octets source intacts`);
    }
    assert.deepEqual((await fs.readdir(harness.dir('refus'))).sort(), cases.map(([name]) => name).sort());
    assert.equal(harness.countCalls('validate_advanced_payload'), 0, 'refus avant toute validation Rust');
    assert.equal(harness.countCalls('plugin:fs|write_text_file'), 0, 'aucun réenregistrement');
  });
});

test('un projet avancé s’enregistre et se copie sans appeler Rust ni toucher au payload', async () => {
  await withHarness(async (harness) => {
    const projectDir = await harness.mkdirp('avance');
    await harness.writeFile('avance/medias/a1b2c3.mp3', 'audio');
    const project = advancedProject([
      { assetRef: 'a1b2c3.mp3', path: `${projectDir}/medias/a1b2c3.mp3`, status: 'resolved' },
      { assetRef: 'd4e5f6.png', path: `${projectDir}/medias/disparu.png`, status: 'missing' },
      { assetRef: 'sans-fichier.ogg', path: null, status: 'missing' },
    ]);
    const savePath = `${projectDir}/renard.mbah`;
    const saved = await io.saveProject(project, savePath);

    const written = await readJson(savePath);
    assert.equal(written.schemaVersion, 4);
    assert.equal(written.authoringMode, 'advanced');
    assert.equal(written.authoring.payload, PAYLOAD, 'la chaîne validée est celle qui est réécrite');
    assert.match(await fs.readFile(savePath, 'utf8'), /9007199254740993/);
    assert.deepEqual(written.authoring.editorState, project.authoring.editorState);
    assert.deepEqual(written.authoring.mediaBindings, [
      { assetRef: 'a1b2c3.mp3', path: './medias/a1b2c3.mp3', status: 'resolved' },
      { assetRef: 'd4e5f6.png', path: './medias/disparu.png', status: 'missing' },
      { assetRef: 'sans-fichier.ogg', path: null, status: 'missing' },
    ]);
    assert.deepEqual(saved.mediaLibraryPaths, [`${projectDir}/medias/a1b2c3.mp3`, `${projectDir}/medias/disparu.png`]);

    const copyDir = await harness.mkdirp('avance-copie');
    harness.answerSave(`${copyDir}/copie.mbah`);
    const copied = await io.saveProjectAs(saved.project, savePath);
    const copiedFile = await readJson(copied.path);
    assert.equal(copiedFile.authoring.payload, PAYLOAD, 'Save As conserve l’identité du pack telle quelle');
    assert.equal(copiedFile.projectName, 'copie', 'seules les métadonnées locales suivent le fichier');
    assert.equal(copiedFile.authoring.mediaBindings[0].path, `${projectDir}/medias/a1b2c3.mp3`,
      'un média hors du nouveau dossier reste absolu et résoluble');
    assert.deepEqual(await readJson(savePath), written, 'la source précédente est intacte');
    assert.equal(harness.countCalls('validate_advanced_payload'), 0, 'l’écriture n’appelle jamais Rust');
  });
});

test('la consolidation avancée copie les liaisons, déclare les manquants et ignore l’opaque', async () => {
  await withHarness(async (harness) => {
    const projectDir = await harness.mkdirp('source');
    await harness.writeFile('source/medias/intro.mp3', 'audio-medias');
    await harness.writeFile('source/voix/intro.mp3', 'audio-voix');
    const project = advancedProject([
      { assetRef: 'a1b2c3.mp3', path: `${projectDir}/medias/intro.mp3`, status: 'resolved' },
      { assetRef: 'homonyme.mp3', path: `${projectDir}/voix/intro.mp3`, status: 'resolved' },
      { assetRef: 'partage.mp3', path: `${projectDir}/medias/intro.mp3`, status: 'resolved' },
      { assetRef: 'd4e5f6.png', path: `${projectDir}/medias/disparu.png`, status: 'resolved' },
      { assetRef: 'sans-fichier.ogg', path: null, status: 'missing' },
    ]);
    const destination = await harness.mkdirp('consolide');
    const result = await io.consolidateProject(project, `${projectDir}/renard.mbah`, destination);

    assert.equal(result.copiedCount, 2, 'un fichier partagé par deux liaisons n’est copié qu’une fois');
    assert.deepEqual(result.errors.map((error) => error.path), [`${projectDir}/medias/disparu.png`]);

    const written = await readJson(result.path);
    const bindings = Object.fromEntries(written.authoring.mediaBindings.map((b) => [b.assetRef, b]));
    assert.equal(bindings['a1b2c3.mp3'].path, './assets/audio/intro.mp3');
    assert.equal(bindings['partage.mp3'].path, './assets/audio/intro.mp3', 'l’association suit assetRef, pas le nom');
    assert.match(bindings['homonyme.mp3'].path, /^\.\/assets\/audio\/intro--\d+-\d+\.mp3$/);
    assert.equal(bindings['d4e5f6.png'].path, `${projectDir}/medias/disparu.png`, 'dernier chemin connu conservé');
    assert.equal(bindings['d4e5f6.png'].status, 'missing');
    assert.equal(bindings['sans-fichier.ogg'].path, null);
    assert.equal(bindings['sans-fichier.ogg'].status, 'missing');
    assert.equal(bindings['a1b2c3.mp3'].status, 'resolved');
    assert.equal(written.authoring.payload, PAYLOAD, 'aucun média de l’opaque n’est aspiré par la copie');

    assert.equal(await harness.readFile(`${destination}/assets/audio/intro.mp3`), 'audio-medias');
    assert.equal(await harness.readFile(`${destination}/assets/audio/${bindings['homonyme.mp3'].path.split('/').pop()}`), 'audio-voix');
    // Artefact assumé : le dossier de catégorie est créé avant la copie, donc une
    // copie échouée laisse un répertoire vide. Aucun média n'y entre.
    assert.deepEqual((await fs.readdir(`${destination}/assets`)).sort(), ['audio', 'images']);
    assert.deepEqual(await fs.readdir(`${destination}/assets/images`), []);
  });
});

test('le transfert d’un projet avancé copie hors du projet et requalifie les liaisons copiées', async () => {
  await withHarness(async (harness) => {
    const projectDir = await harness.mkdirp('projet');
    const externe = await harness.mkdirp('externe');
    await harness.writeFile('externe/voix.mp3', 'voix');
    await harness.writeFile('projet/medias/interne.mp3', 'interne');
    const savePath = `${projectDir}/renard.mbah`;
    const project = advancedProject([
      { assetRef: 'externe.mp3', path: `${externe}/voix.mp3`, status: 'missing' },
      { assetRef: 'interne.mp3', path: `${projectDir}/medias/interne.mp3`, status: 'resolved' },
    ]);

    const candidates = io.collectTransferableProjectFiles(project, savePath);
    assert.deepEqual(candidates.map((candidate) => candidate.path), [`${externe}/voix.mp3`]);
    assert.deepEqual(candidates.map((candidate) => candidate.label), ['Média avancé: externe.mp3']);

    const transferred = await io.transferProjectFilesToProject(
      project,
      savePath,
      (sourcePath) => io.copyMediaToWorkspace(sourcePath, harness.workspace, 'fichiers-importes', 'renard'),
    );
    assert.equal(transferred.copiedCount, 1);
    const bindings = Object.fromEntries(transferred.project.authoring.mediaBindings.map((b) => [b.assetRef, b]));
    assert.equal(bindings['externe.mp3'].path, `${harness.workspace}/fichiers-importes/renard__voix.mp3`);
    assert.equal(bindings['externe.mp3'].status, 'resolved', 'une copie réussie est un fait de disque');
    assert.equal(bindings['interne.mp3'].path, `${projectDir}/medias/interne.mp3`, 'un média déjà géré n’est pas déplacé');
    assert.equal(transferred.project.authoring.payload, PAYLOAD);
    assert.equal(await harness.readFile(bindings['externe.mp3'].path), 'voix');

    // Échec de copie : la liaison garde son dernier chemin connu et l'erreur est
    // rendue à l'appelant, jamais avalée pour faire passer une sauvegarde.
    const failing = await io.transferProjectFilesToProject(
      project,
      savePath,
      () => { throw new Error('disque plein'); },
    );
    assert.equal(failing.copiedCount, 0);
    assert.deepEqual(failing.errors.map((error) => [error.path, error.label]),
      [[`${externe}/voix.mp3`, 'Média avancé: externe.mp3']]);
    assert.equal(failing.project.authoring.mediaBindings[0].path, `${externe}/voix.mp3`);
    assert.equal(failing.project.authoring.mediaBindings[0].status, 'missing');
  });
});

// ── Étiquettes : deux formes de chemin pour un seul fichier ──────────────────

test('une étiquette suit son média quelle que soit la forme du chemin', async () => {
  await withHarness(async (harness) => {
    const projectDir = await harness.mkdirp('etiquettes');
    const audio = await harness.writeFile('etiquettes/medias/intro.mp3', 'audio');
    const project = normalizeProjectData({
      projectName: 'etiquettes',
      projectType: 'pack',
      rootEntries: [{ id: 'story-1', type: 'story', name: 'Histoire' }],
      rootAudio: audio,
    });
    const savePath = `${projectDir}/etiquettes.mbah`;
    await io.saveProject(project, savePath, null, { mediaTags: { [audio]: ['préférée'] } });

    const reopened = await io.loadProjectFromPath(savePath);
    // Le champ racine passe par `normalizeWindowsPath`, la clé d'étiquette par la
    // résolution des chemins relatifs : sous Windows les deux formes diffèrent,
    // ailleurs elles coïncident. Le test ne suppose ni l'un ni l'autre.
    const item = collectMediaLibrary({ project: reopened.data })
      .find((media) => media.path.toLowerCase().includes('intro.mp3'));
    assert.ok(item, 'le média de couverture est dans la bibliothèque');

    const tagsOf = createMediaTagLookup(reopened.mediaTags);
    assert.deepEqual(tagsOf(item.path), ['préférée'],
      'l’étiquette reste attachée au média que l’explorateur affiche');
    assert.deepEqual(tagsOf(reopened.data.rootAudio), ['préférée'],
      'et au champ racine, qui porte l’autre forme');

    // Une écriture réemploie la clé existante : deux entrées pour un seul
    // fichier se masqueraient l'une l'autre et seraient relativisées deux fois.
    const written = withMediaTag(reopened.mediaTags, item.path, 'seconde');
    assert.deepEqual(Object.keys(written), Object.keys(reopened.mediaTags),
      'la clé retenue est celle déjà présente, pas une seconde forme');
    assert.deepEqual(written[Object.keys(reopened.mediaTags)[0]], ['préférée', 'seconde']);
  });
});
