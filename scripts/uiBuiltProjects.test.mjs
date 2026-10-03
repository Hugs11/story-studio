// Un projet créé par les gestes d'un éditeur, jusqu'à ce que reçoit le
// moteur de génération.
//
// Les hooks de production (store, mutations, import, fiche du pack puis
// « Générer ») sont exécutés intacts ; chaque geste appelle la fonction que
// son champ appelle dans l'interface. Le test capture le `projectJson` que la
// file de rendu passerait à `generate_pack` et le compare à
// scripts/fixtures/ui-built-projects/. Le test Rust
// (src-tauri/src/commands/generation_ui_projects_tests.rs) génère réellement
// ces fichiers : un changement de ce que l'éditeur produit fait échouer ce test
// tant que la fixture n'est pas réécrite, puis passe par le moteur réel.
//
// Réécrire les fixtures : UPDATE_UI_PROJECT_FIXTURES=1 node --test scripts/uiBuiltProjects.test.mjs
//
// Doublés : l'ordonnanceur React, le dialogue du dossier de sortie, la copie
// des médias (désactivée) et leur lecture de pochette. Les identifiants
// aléatoires sont rendus déterministes pour que la fixture soit stable.
// Les chemins de médias sont sous `/ui-media/` : le test Rust y substitue un
// dossier où il fabrique des sons et des images synthétiques.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useProjectMutations } = await import('../src/hooks/useProjectMutations.js');
const { useImportSession } = await import('../src/hooks/useImportSession.js');
const { usePackGeneration } = await import('../src/hooks/usePackGeneration.js');
const { buildProjectIndex } = await import('../src/store/projectModel.js');
const { encodeMenuNavigationTarget, encodeStoryNavigationTarget } = await import('../src/store/navigationTargets.js');
const { createStorySelectionAudioUpdate } = await import('../src/store/storyTitleStage.js');

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ui-built-projects');
const MEDIA = '/ui-media';
const noop = () => {};

function deterministicIds() {
  const original = crypto.randomUUID;
  let counter = 0;
  crypto.randomUUID = () => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  };
  return () => { crypto.randomUUID = original; };
}

async function mountEditor(t) {
  const restoreIds = deterministicIds();
  const disk = await createDiskHarness();
  t.after(async () => {
    restoreIds();
    await disk.dispose();
  });
  const jobs = [];
  const dialogs = [];
  let store; let mutations; let session; let generation;
  const app = runner(() => {
    store = useProjectStore();
    mutations = useProjectMutations({ store });
    session = useImportSession({
      store,
      projectIndex: buildProjectIndex(store.project),
      maybeCopyToProject: async (file) => file,
      extractAudioEmbeddedImage: async () => null,
      setImporting: noop,
      setUnpacking: noop,
      setImportNotice: noop,
      persistProjectSnapshot: async () => null,
      workspaceDirRef: { current: '' },
      showErrorDialog: (dialog) => dialogs.push(dialog),
      getImportDisplayName: (file) => file,
      isImportedPackPath: (file) => file.endsWith('.zip'),
      onImportedPackPromoted: noop,
    });
    generation = usePackGeneration({
      store,
      renderQueue: { addJob: (job) => jobs.push(job) },
      pathAudit: {},
      pathAuditPending: false,
      workspaceDirRef: { current: '' },
      importedPackPendingMetaRef: { current: false },
      showErrorDialog: (dialog) => dialogs.push(dialog),
      showChoiceDialog: async () => null,
    });
  });
  app.render();
  // Dossier de sortie choisi dans le dialogue qui suit la fiche du pack.
  disk.answerOpen(disk.dir('sortie'));
  return {
    get store() { return store; },
    get mutations() { return mutations; },
    get session() { return session; },
    get generation() { return generation; },
    jobs,
    dialogs,
    render: () => app.render(),
    // Accueil → type de projet : `handleNewProject` vide le projet, puis
    // `handleSelectProjectType` → `prepareNewWorkSession` pose le type.
    newProject(type) {
      store.resetProject();
      app.render();
      store.setProjectType(type);
      store.markPristine();
      app.render();
    },
    // Fiche du pack (PackNameModal) : son brouillon part de la fiche du projet,
    // l'auteur saisit ses champs puis choisit « Enregistrer et générer ».
    async saveAndGenerate(fields) {
      const draft = {
        ...store.project.packMetadata,
        ...fields,
        minAge: '3',
        namingMode: 'convention',
      };
      await generation.handleSavePackMetadata(draft, { generate: true });
      app.render();
    },
  };
}

// La cible de la sortie ne dépend que de la machine : elle n'entre pas dans la fixture.
function exportedProject(editor) {
  assert.deepEqual(editor.dialogs, [], 'aucun refus ni erreur affichés');
  assert.equal(editor.jobs.length, 1, 'un travail de génération enfilé');
  return JSON.parse(editor.jobs[0].projectJson);
}

function checkFixture(name, project) {
  const file = path.join(FIXTURES, `${name}.json`);
  const text = `${JSON.stringify(project, null, 2)}\n`;
  if (process.env.UPDATE_UI_PROJECT_FIXTURES === '1') {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.ok(fs.existsSync(file), `fixture absente : ${file}`);
  assert.deepEqual(
    project,
    JSON.parse(fs.readFileSync(file, 'utf8')),
    `L'éditeur produit un autre projet que ${file}. Si c'est voulu, réécrire la fixture `
      + '(UPDATE_UI_PROJECT_FIXTURES=1) puis relancer le test Rust qui la génère.',
  );
}

test('un projet de l’éditeur simplifié, rempli par ses champs, part à la génération', async (t) => {
  const editor = await mountEditor(t);
  editor.newProject('simple');

  // RootEditor : « Nom de l'histoire », image, titre audio, audio du récit.
  editor.mutations.handleUpdateRoot({ projectName: 'Histoire de test', packMetadata: { title: 'Histoire de test' } });
  editor.render();
  const sameImage = !!editor.store.project.sameImage;
  editor.store.updateRootMedia('rootImage', `${MEDIA}/couverture.png`);
  if (sameImage) editor.store.updateRootMedia('thumbnailImage', `${MEDIA}/couverture.png`);
  editor.store.updateRootMedia('autoGenerateRootImage', false);
  editor.store.updateRootMedia('rootAudio', `${MEDIA}/titre.wav`);
  editor.store.updateStoryAudio(`${MEDIA}/recit.wav`);
  editor.render();

  await editor.saveAndGenerate({ title: 'Histoire de test', author: 'Auteur de test', version: 1 });

  const project = exportedProject(editor);
  assert.equal(project.projectType, 'simple');
  assert.equal(project.rootEntries.length, 1);
  checkFixture('simple', project);
});

test('un projet de l’éditeur par menus, rempli par ses champs, part à la génération', async (t) => {
  const editor = await mountEditor(t);
  editor.newProject('pack');

  // RootEditor : nom du menu racine, image de couverture, titre audio.
  editor.mutations.handleUpdateRoot({ rootName: 'Menu de test' });
  const sameImage = !!editor.store.project.sameImage;
  editor.store.updateRootMedia('rootImage', `${MEDIA}/couverture.png`);
  if (sameImage) editor.store.updateRootMedia('thumbnailImage', `${MEDIA}/couverture.png`);
  editor.store.updateRootMedia('autoGenerateRootImage', false);
  editor.store.updateRootMedia('rootAudio', `${MEDIA}/titre.wav`);
  editor.render();

  // Arbre : « Nouveau dossier », puis MenuEditor (nom, son, image).
  const menuId = editor.mutations.handleAddMenu(null);
  editor.render();
  editor.mutations.handleUpdateMenu({ name: 'Dossier de test' }, menuId);
  editor.mutations.handleUpdateMenu({ audio: `${MEDIA}/dossier.wav` }, menuId);
  editor.mutations.handleUpdateMenu({ image: `${MEDIA}/dossier.png`, autoGenerateImage: false }, menuId);
  editor.render();

  // Deux sons importés dans le dossier (« Ajouter des histoires »), puis
  // StoryEditor : image et titre audio de chacune.
  await editor.session.dispatchFiles(menuId, [`${MEDIA}/histoire-1.wav`, `${MEDIA}/histoire-2.wav`]);
  editor.render();
  const [first, second] = editor.store.project.rootEntries[0].children;
  assert.deepEqual([first?.type, second?.type], ['story', 'story']);
  for (const [index, story] of [first, second].entries()) {
    editor.mutations.handleUpdateItem({ itemImage: `${MEDIA}/histoire-${index + 1}.png`, autoGenerateImage: false }, story.id);
    editor.mutations.handleUpdateItem(createStorySelectionAudioUpdate(`${MEDIA}/histoire-${index + 1}-titre.wav`), story.id);
    editor.render();
  }

  // Réglages de fin ordinaires (AfterPlaySection) : la première histoire
  // enchaîne sur la seconde ; la seconde joue une fin locale dont OK revient
  // au dossier.
  editor.mutations.handleUpdateItem({ returnAfterPlay: encodeStoryNavigationTarget(second.id) }, first.id);
  editor.mutations.handleUpdateItem({ afterPlaybackPromptAudio: `${MEDIA}/fin.wav` }, second.id);
  editor.render();
  editor.mutations.handleUpdateItem({ afterPlaybackPromptOkTarget: encodeMenuNavigationTarget(menuId) }, second.id);
  editor.render();

  await editor.saveAndGenerate({ title: 'Pack de test', author: 'Auteur de test', version: 1 });

  const project = exportedProject(editor);
  assert.equal(project.projectType, 'pack');
  checkFixture('menus', project);
});
