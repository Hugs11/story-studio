// Les outils de son des deux côtés.
//
// Ce que cette suite garde tient en une phrase : les quatre outils sont les
// mêmes, et seul leur point d'arrivée change. Elle vérifie donc deux choses, et
// aucune apparence : ce que la barre offre dans chaque éditeur, et où le son
// produit atterrit.
//
// La preuve centrale est négative. Côté graphe, **aucun plan d'atterrissage ne
// porte d'identifiant de dossier**, donc aucun outil ne peut créer d'Écran : un
// podcast qui se télécharge ne modifie pas le document. C'est voulu, et c'est
// ce qu'un plan de valeur — plutôt qu'un effet direct — permet de constater
// sans monter d'écran.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MEDIA_LANDING_LIBRARY,
  MEDIA_LANDING_TREE,
  MEDIA_TOOL_ACTIONS,
  mediaToolActionIds,
  mediaToolLanding,
  planProducedMediaLanding,
} from '../src/store/mediaToolSurface.js';
import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
  WORKSPACE_MODE_HOME,
} from '../src/store/projectWorkState.js';

const SOUND_TOOLS = [
  MEDIA_TOOL_ACTIONS.IMPORT_PODCAST,
  MEDIA_TOOL_ACTIONS.IMPORT_YOUTUBE,
  MEDIA_TOOL_ACTIONS.RECORD,
  MEDIA_TOOL_ACTIONS.GENERATE_TTS,
];

const TREE_ONLY = [
  MEDIA_TOOL_ACTIONS.IMPORT_STORY,
  MEDIA_TOOL_ACTIONS.ADD_FOLDER,
  MEDIA_TOOL_ACTIONS.IMPORT_FOLDER,
];

test('les quatre outils de son sont offerts dans les deux éditeurs', () => {
  for (const mode of [WORKSPACE_MODE_HIERARCHICAL, WORKSPACE_MODE_ADVANCED]) {
    const offered = mediaToolActionIds(mode);
    for (const tool of SOUND_TOOLS) {
      assert.ok(offered.includes(tool), `${tool} manque en mode ${mode}`);
    }
  }
});

test('la barre du graphe ne montre aucune action sans objet', () => {
  const offered = mediaToolActionIds(WORKSPACE_MODE_ADVANCED);
  for (const treeAction of TREE_ONLY) {
    assert.ok(!offered.includes(treeAction), `${treeAction} n'a pas d'objet sur un graphe`);
  }
  // Ce qu'elle offre à la place de l'import d'histoires : l'entrée dans la
  // bibliothèque, seule forme d'import qui ait un sens sans arbre.
  assert.ok(offered.includes(MEDIA_TOOL_ACTIONS.IMPORT_MEDIA));
});

test('la barre de l’arbre garde exactement ses actions propres', () => {
  assert.deepEqual(mediaToolActionIds(WORKSPACE_MODE_HIERARCHICAL), [
    MEDIA_TOOL_ACTIONS.IMPORT_STORY,
    MEDIA_TOOL_ACTIONS.ADD_FOLDER,
    MEDIA_TOOL_ACTIONS.IMPORT_FOLDER,
    MEDIA_TOOL_ACTIONS.IMPORT_PODCAST,
    MEDIA_TOOL_ACTIONS.IMPORT_YOUTUBE,
    MEDIA_TOOL_ACTIONS.RECORD,
    MEDIA_TOOL_ACTIONS.GENERATE_TTS,
    MEDIA_TOOL_ACTIONS.SIMULATOR,
  ]);
  // L'entrée en bibliothèque reste propre au graphe : côté Libre, la
  // médiathèque porte déjà ce même import, et l'offrir deux fois dans la même
  // colonne serait une duplication, comme pour les options du pack.
  assert.ok(!mediaToolActionIds(WORKSPACE_MODE_HIERARCHICAL).includes(MEDIA_TOOL_ACTIONS.IMPORT_MEDIA));
});

// L'écoute occupe la même rangée et prend la même forme des deux côtés : une
// seule action, un seul composant, une seule icône. Deux boutons de formes
// différentes pour un même geste seraient une divergence de plus, et une place
// de plus à trouver.
test('l’écoute est la même action dans les deux éditeurs', () => {
  for (const mode of [WORKSPACE_MODE_HIERARCHICAL, WORKSPACE_MODE_ADVANCED]) {
    assert.ok(mediaToolActionIds(mode).includes(MEDIA_TOOL_ACTIONS.SIMULATOR));
  }
});

test('le point d’arrivée suit l’éditeur, et l’accueil retombe sur l’arbre', () => {
  assert.equal(mediaToolLanding(WORKSPACE_MODE_ADVANCED), MEDIA_LANDING_LIBRARY);
  assert.equal(mediaToolLanding(WORKSPACE_MODE_HIERARCHICAL), MEDIA_LANDING_TREE);
  assert.equal(mediaToolLanding(WORKSPACE_MODE_HOME), MEDIA_LANDING_TREE);
});

test('côté Libre, le son produit devient une histoire dans le dossier visé', () => {
  const plan = planProducedMediaLanding({
    landing: MEDIA_LANDING_TREE,
    audioPath: 'fichiers-importes/episode.mp3',
    imagePath: 'fichiers-importes/episode-vignette.jpg',
    targetMenuId: 'menu-4',
  });

  assert.deepEqual({ ...plan }, {
    kind: MEDIA_LANDING_TREE,
    menuId: 'menu-4',
    audioPath: 'fichiers-importes/episode.mp3',
    imagePath: 'fichiers-importes/episode-vignette.jpg',
  });
});

test('sans dossier visé, le son produit reste à la racine comme avant', () => {
  const plan = planProducedMediaLanding({
    landing: MEDIA_LANDING_TREE,
    audioPath: 'fichiers-importes/episode.mp3',
  });

  assert.equal(plan.menuId, null);
  assert.equal(plan.imagePath, null);
});

test('côté graphe, le son produit entre en bibliothèque, vignette comprise', () => {
  const plan = planProducedMediaLanding({
    landing: MEDIA_LANDING_LIBRARY,
    audioPath: 'fichiers-importes/episode.mp3',
    imagePath: 'fichiers-importes/episode-vignette.jpg',
  });

  assert.equal(plan.kind, MEDIA_LANDING_LIBRARY);
  assert.deepEqual([...plan.paths], [
    'fichiers-importes/episode.mp3',
    'fichiers-importes/episode-vignette.jpg',
  ]);
});

test('côté graphe, aucun plan ne porte de dossier — donc aucun Écran n’est créé', () => {
  // Y compris quand un appelant tend une cible d'arbre par mégarde : la
  // décision appartient au point d'arrivée, pas à l'appelant.
  const plan = planProducedMediaLanding({
    landing: MEDIA_LANDING_LIBRARY,
    audioPath: 'fichiers-importes/voix.mp3',
    targetMenuId: 'menu-4',
  });

  assert.ok(!('menuId' in plan));
  assert.deepEqual([...plan.paths], ['fichiers-importes/voix.mp3']);
});

test('un outil qui n’a rien produit ne fait rien atterrir', () => {
  assert.equal(planProducedMediaLanding({ landing: MEDIA_LANDING_LIBRARY, audioPath: null }), null);
  assert.equal(planProducedMediaLanding({ landing: MEDIA_LANDING_TREE, audioPath: '' }), null);
});

// La moitié disque du dépôt est partagée : les quatre outils s'appuient
// dessus, et un son produit passe par les mêmes fonctions de copie,
// quel que soit l'éditeur ouvert. Ce test garde cette absence de couture — une
// branche par mode y réintroduirait deux comportements de préférence.
test('la copie dans l’espace de travail ne connaît pas l’éditeur ouvert', () => {
  const source = readFileSync(
    new URL('../src/hooks/useMediaTransferHandlers.js', import.meta.url),
    'utf8',
  );

  for (const modeTest of ['authoringWorkspaceMode', 'isAdvancedProject', 'WORKSPACE_MODE']) {
    assert.ok(!source.includes(modeTest), `la copie disque teste le mode via ${modeTest}`);
  }
  // Les deux seules fonctions de copie, et la seule préférence qu'elles lisent.
  assert.match(source, /const maybeCopyToProject = useCallback/);
  assert.match(source, /const copyGeneratedMediaToProject = useCallback/);
  assert.match(source, /if \(!copyImportedFilesEnabled\) return filePath;/);
});

// Les quatre outils n'écrivent dans le document qu'à leur point d'arrivée :
// vérifié outil par outil en lisant leur surface. Si l'un d'eux se mettait à
// toucher le projet en cours de route, il ne s'agirait plus d'un
// simple déménagement de point d'arrivée, et ce test le dirait.
test('aucun des quatre outils n’écrit dans le document en cours de route', () => {
  const surfaces = [
    '../src/components/RecordModal/RecordModal.jsx',
    '../src/components/PodcastImport/PodcastImportModal.jsx',
    '../src/components/YoutubeImport/YoutubeImportFunnel.jsx',
    '../src/components/GenerateVoiceModal/GenerateVoiceModal.jsx',
  ];

  for (const surface of surfaces) {
    const source = readFileSync(new URL(surface, import.meta.url), 'utf8');
    for (const write of ['useProjectStore', 'store.addStory', 'store.updateItem', 'store.setProject']) {
      assert.ok(!source.includes(write), `${surface} écrit dans le document via ${write}`);
    }
  }
});
