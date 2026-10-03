// Les hooks et les dialogues de production ; seuls React et l'IPC sont doublés.
// Les téléchargements rendent des chemins fictifs, chaque dialogue est annulé.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import { createDiskHarness } from './tauriDiskHarness.mjs';

const { useProjectStore } = await import('../src/store/projectStore.js');
const { useProjectMutations } = await import('../src/hooks/useProjectMutations.js');
const { useMediaImport } = await import('../src/hooks/useMediaImport.js');
const { saveProject, saveProjectAs } = await import('../src/store/projectIO.js');
const { createAdvancedProject, withAuthoringPayload } = await import('../src/store/projectModel/authoring.js');
const { setLogLevel } = await import('../src/utils/logger.js');
setLogLevel('off');

const noop = () => {};
const PAYLOAD = '{"payloadVersion":1,"document":{"stageNodes":[],"actionNodes":[]},'
  + '"context":{"documentOrigin":"created","defaultValueOrigin":"authored"}}';
const ITEMS = [{ title: 'Titre de la piste', audioUrl: 'mock://audio' }];

function context({ mode = 'pack', projectName = '', graphTitle = 'Nouveau pack' } = {}) {
  localStorage.clear();
  const dialogs = [];
  const library = [];
  const graphReads = [];
  let download = async ({ fileName }) => `C:/fixture/${fileName}.mp3`;
  let readGraph = async () => ({ metadata: { title: { presence: 'value', value: graphTitle } } });
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === 'plugin:dialog|save') {
      dialogs.push(args.options);
      return null;
    }
    if (command === 'read_advanced_graph_view') {
      graphReads.push(args.payload);
      return readGraph(args.payload);
    }
    if (command === 'download_youtube_audio' || command === 'download_podcast_media') {
      return download(args);
    }
    throw new Error(`Commande inattendue : ${command}`);
  };
  let current;
  const hooks = runner(() => {
    const store = useProjectStore();
    return {
      store,
      mutations: useProjectMutations({ store }),
      imports: useMediaImport({
        store,
        projectIndex: { entryById: new Map(), parentMenuById: new Map() },
        maybeCopyToProject: async (path) => path,
        copyGeneratedMediaToProject: async (path) => path,
        extractAudioEmbeddedImage: async () => null,
        addPathsToMediaLibrary: (paths) => library.push(...paths),
        persistProjectSnapshot: async () => null,
        workspaceDirRef: { current: 'C:/fixture' },
        importedPackPendingMetaRef: { current: false },
        runFunnelLanding: async (type, work) => {
          store.resetProject();
          store.setProjectType(type);
          await work();
        },
        onRevealImportedMedia: noop,
        setImportNotice: noop,
        setActiveDropZone: noop,
        showErrorDialog: noop,
      }),
    };
  });
  current = hooks.render();
  if (mode === 'advanced') {
    current.store.loadProject(createAdvancedProject({ payload: PAYLOAD, projectName }));
  } else {
    current.store.setProjectType(mode);
    if (projectName) current.store.updateProjectName(projectName);
  }
  current = hooks.render();
  return {
    read: () => (current = hooks.render()),
    library,
    graphReads,
    setDownload: (handler) => { download = handler; },
    setReadGraph: (handler) => { readGraph = handler; },
    async suggestions(currentSavePath = null) {
      const project = this.read().store.project;
      const before = JSON.stringify(project);
      assert.equal(await saveProject(project), null);
      assert.equal(await saveProjectAs(project, currentSavePath), null);
      assert.equal(JSON.stringify(project), before, 'proposer un nom ne modifie pas le projet');
      return dialogs.slice(-2).map((dialog) => dialog.defaultPath.replace(/^.*[/\\]/, ''));
    },
  };
}

test('renommer la racine gagne sur le nom local dans les deux dialogues', async () => {
  const ctx = context({ projectName: 'Ancienne piste YouTube' });
  ctx.read().mutations.handleUpdateRoot({ rootName: 'Mon histoire renommée' });
  assert.deepEqual(await ctx.suggestions('C:/fixture/ancien.mbah'), [
    'Mon histoire renommée.mbah', 'Mon histoire renommée.mbah',
  ]);
});

test('un projet vierge propose Projet sans titre ; les espaces ne font pas un nom', async () => {
  const ctx = context();
  assert.deepEqual(await ctx.suggestions(), ['Projet sans titre.mbah', 'Projet sans titre.mbah']);
  ctx.read().mutations.handleUpdateRoot({ rootName: '   ', projectName: '   ' });
  assert.deepEqual(await ctx.suggestions(), ['Projet sans titre.mbah', 'Projet sans titre.mbah']);
});

test('le titre de la fiche du pack est utilisable quand la racine reste générique', async () => {
  const ctx = context();
  ctx.read().mutations.handleUpdateRoot({ packMetadata: { title: 'Titre du pack' } });
  assert.deepEqual(await ctx.suggestions(), ['Titre du pack.mbah', 'Titre du pack.mbah']);
});

test('le nom proposé est nettoyé après le choix du titre courant', async () => {
  const ctx = context({ projectName: 'Ancien titre' });
  ctx.read().mutations.handleUpdateRoot({ rootName: '  Conte: [a/b]+?  ' });
  assert.deepEqual(await ctx.suggestions(), ['Conte_ _a_b___.mbah', 'Conte_ _a_b___.mbah']);
});

for (const source of ['Youtube', 'Podcast']) {
  for (const entry of ['Editor', 'Funnel']) {
    test(`${source} depuis ${entry} : source en repli, racine renommée prioritaire`, async () => {
      const ctx = context();
      await ctx.read().imports[`handle${source}${entry}Import`](ITEMS, { title: 'Titre de la source' });
      assert.equal(ctx.read().store.project.projectName, 'Titre de la source');
      assert.deepEqual(await ctx.suggestions(), ['Titre de la source.mbah', 'Titre de la source.mbah']);
      ctx.read().mutations.handleUpdateRoot({ rootName: 'Titre choisi' });
      assert.deepEqual(await ctx.suggestions(), ['Titre choisi.mbah', 'Titre choisi.mbah']);
      ctx.read().mutations.handleUpdateRoot({ rootName: '' });
      assert.deepEqual(await ctx.suggestions(), ['Titre de la source.mbah', 'Titre de la source.mbah']);
    });
  }

  test(`${source} dans le graphe : source en repli, titre du document prioritaire`, async () => {
    const ctx = context({ mode: 'advanced', projectName: 'Nouveau pack' });
    await ctx.read().imports[`handle${source}EditorImport`](ITEMS, { title: 'Titre de la source' });
    assert.equal(ctx.read().store.project.projectName, 'Titre de la source');
    assert.equal(ctx.library.length, 1);
    assert.deepEqual(ctx.read().store.project.rootEntries, []);
    assert.deepEqual(await ctx.suggestions(), ['Titre de la source.mbah', 'Titre de la source.mbah']);
    ctx.setReadGraph(async () => ({ metadata: { title: { presence: 'value', value: 'Titre choisi' } } }));
    assert.deepEqual(await ctx.suggestions(), ['Titre choisi.mbah', 'Titre choisi.mbah']);
    assert.equal(ctx.read().store.project.authoring.payload, PAYLOAD);
  });

  test(`${source} : les imports suivants gardent le premier repli et le nom local choisi`, async () => {
    const ctx = context();
    await ctx.read().imports[`handle${source}EditorImport`](ITEMS, { title: 'Première source' });
    await ctx.read().imports[`handle${source}EditorImport`](ITEMS, { title: 'Deuxième source' });
    assert.equal(ctx.read().store.project.projectName, 'Première source');
    ctx.read().store.updateProjectName('projet');
    ctx.read().store.setSavePath('C:/fixture/projet.mbah');
    await ctx.read().imports[`handle${source}EditorImport`](ITEMS, { title: 'Troisième source' });
    assert.equal(ctx.read().store.project.projectName, 'projet');
  });

  test(`${source} depuis l’accueil après le graphe crée un pack par menus et nomme sa racine courante`, async () => {
    const ctx = context({ mode: 'advanced', projectName: 'Ancien graphe', graphTitle: 'Ancien titre graphe' });
    await ctx.read().imports[`handle${source}FunnelImport`](ITEMS, { title: 'Nouvelle source' });
    assert.equal(ctx.read().store.project.authoringMode, 'free');
    ctx.read().mutations.handleUpdateRoot({ rootName: 'Nouvelle racine' });
    assert.deepEqual(await ctx.suggestions(), ['Nouvelle racine.mbah', 'Nouvelle racine.mbah']);
    assert.deepEqual(ctx.graphReads, []);
  });
}

test('un import sans titre ou entièrement échoué ne fournit aucun repli', async () => {
  const ctx = context();
  await ctx.read().imports.handlePodcastEditorImport(ITEMS, { title: '   ' });
  assert.equal(ctx.read().store.project.projectName, '');
  ctx.setDownload(async () => { throw new Error('panne simulée'); });
  await ctx.read().imports.handlePodcastEditorImport(ITEMS, { title: 'Podcast échoué' });
  assert.equal(ctx.read().store.project.projectName, '');
});

test('un import tardif ne nomme pas le projet qui remplace son projet de départ', async () => {
  const ctx = context();
  let finish;
  ctx.setDownload(() => new Promise((resolve) => { finish = resolve; }));
  const pending = ctx.read().imports.handlePodcastEditorImport(ITEMS, { title: 'Ancien podcast' });
  ctx.read().store.resetProject();
  ctx.read().store.setProjectType('pack');
  ctx.read();
  finish('C:/fixture/episode.mp3');
  await pending;
  assert.equal(ctx.read().store.project.projectName, '');
});

test('le nom saisi pendant un import reste prioritaire sur la source', async () => {
  const ctx = context();
  let finish;
  ctx.setDownload(() => new Promise((resolve) => { finish = resolve; }));
  const pending = ctx.read().imports.handlePodcastEditorImport(ITEMS, { title: 'Podcast' });
  ctx.read().store.updateProjectName('Nom choisi entre-temps');
  ctx.read();
  finish('C:/fixture/episode.mp3');
  await pending;
  assert.equal(ctx.read().store.project.projectName, 'Nom choisi entre-temps');
});

test('un fichier choisi pendant un import garde son nom local, même générique', async () => {
  const ctx = context();
  let finish;
  ctx.setDownload(() => new Promise((resolve) => { finish = resolve; }));
  const pending = ctx.read().imports.handlePodcastEditorImport(ITEMS, { title: 'Podcast' });
  ctx.read().store.updateProjectName('projet');
  ctx.read().store.setSavePath('C:/fixture/projet.mbah');
  ctx.read();
  finish('C:/fixture/episode.mp3');
  await pending;
  assert.equal(ctx.read().store.project.projectName, 'projet');
});

test('le graphe lit le payload courant pour chaque proposition et ne lit pas un titre d’enveloppe', async () => {
  const ctx = context({ mode: 'advanced', projectName: 'Ancien titre', graphTitle: 'Titre actuel' });
  ctx.read().store.setProject((project) => ({ ...project, packMetadata: { title: 'Copie périmée' } }));
  assert.deepEqual(await ctx.suggestions(), ['Titre actuel.mbah', 'Titre actuel.mbah']);
  const nextPayload = PAYLOAD.replace('created', 'imported');
  ctx.read().store.setProject((project) => withAuthoringPayload(project, nextPayload));
  ctx.setReadGraph(async (payload) => {
    assert.equal(payload, nextPayload);
    return { metadata: { title: { presence: 'value', value: 'Titre suivant' } } };
  });
  assert.deepEqual(await ctx.suggestions(), ['Titre suivant.mbah', 'Titre suivant.mbah']);
  assert.deepEqual(ctx.graphReads, [PAYLOAD, PAYLOAD, nextPayload, nextPayload]);
});

test('un graphe sans titre, ou dont la lecture échoue, garde la sauvegarde disponible', async () => {
  const ctx = context({ mode: 'advanced', projectName: 'Nouveau pack' });
  assert.deepEqual(await ctx.suggestions(), ['Projet sans titre.mbah', 'Projet sans titre.mbah']);
  ctx.read().store.updateProjectName('Nom local');
  for (const presence of ['absent', 'null']) {
    ctx.setReadGraph(async () => ({ metadata: { title: { presence } } }));
    assert.deepEqual(await ctx.suggestions(), ['Nom local.mbah', 'Nom local.mbah']);
  }
  ctx.setReadGraph(async () => { throw new Error('lecture indisponible'); });
  assert.deepEqual(await ctx.suggestions(), ['Nom local.mbah', 'Nom local.mbah']);
});

test('une histoire simple reprend son titre et ignore le nom de menu racine', async () => {
  const ctx = context({ mode: 'simple', projectName: 'Ancien nom local' });
  ctx.read().mutations.handleUpdateRoot({ rootName: 'Autre menu', packMetadata: { title: 'Mon histoire' } });
  assert.deepEqual(await ctx.suggestions(), ['Mon histoire.mbah', 'Mon histoire.mbah']);
});

test('sans titre, Enregistrer sous conserve le nom du fichier existant comme repli', async () => {
  const ctx = context({ projectName: 'projet' });
  assert.deepEqual(await ctx.suggestions('C:/fixture/projet.mbah'), ['Projet sans titre.mbah', 'projet.mbah']);
});

test('un enregistrement en place garde le chemin et ne relit pas le graphe pour le nommer', async () => {
  const harness = await createDiskHarness();
  try {
    const path = harness.dir('Nom choisi.mbah');
    const project = createAdvancedProject({ payload: PAYLOAD, projectName: 'Nom choisi' });
    const result = await saveProject(project, path);
    assert.equal(result.path, path);
    assert.equal(result.project.projectName, 'Nom choisi');
    assert.equal(harness.countCalls('plugin:dialog|save'), 0);
    assert.equal(harness.countCalls('read_advanced_graph_view'), 0);
    assert.equal(await harness.exists(path), true);
    assert.equal(JSON.parse(await harness.readFile(path)).projectName, 'Nom choisi');
  } finally {
    await harness.dispose();
  }
});
