// Un seul vocabulaire d'icônes.
//
// La preuve centrale est une table : la nature d'un nœud, et le dessin
// qu'elle porte, pour chacun des deux éditeurs. Elle se dresse sans monter
// React et ces tests la fixent. Le reste vérifie qu'aucun second jeu ne
// subsiste, et que les surfaces peignent cette table au lieu de la refaire.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import {
  ADVANCED_NATURES,
  HIERARCHICAL_NATURES,
  ICON_ARROW_RIGHT,
  ICON_WAYPOINTS,
  ICON_FILE_ARCHIVE,
  ICON_FOLDER,
  ICON_FOLDER_OPEN,
  ICON_FULLSCREEN,
  ICON_HOUSE,
  ICON_MOON,
  ICON_MUSIC,
  ICON_SQUARE,
  hierarchicalNatureOf,
  listVocabularyIconNames,
  NODE_ICON_VOCABULARY,
  resolveNodeIconName,
} from '../src/store/nodeIconVocabulary.js';
import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
  WORKSPACE_MODE_HOME,
} from '../src/store/projectWorkState.js';
import { collectIconSets, SHARED_ICON_SET, unexplainedSets } from './audit-icon-sets.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const readSource = (relative) => readFile(path.join(ROOT, relative), 'utf8');

// ── La table, dressée en entier ────────────────────────────────────────────

test('la table couvre toutes les natures de l\'éditeur par menus', () => {
  assert.deepEqual(NODE_ICON_VOCABULARY[WORKSPACE_MODE_HIERARCHICAL], {
    root: ICON_HOUSE,
    menu: ICON_FOLDER_OPEN,
    story: ICON_MUSIC,
    zip: ICON_FILE_ARCHIVE,
    ref: ICON_ARROW_RIGHT,
    'end-node': ICON_SQUARE,
    'end-night': ICON_MOON,
  });
});

test('la table couvre toutes les natures de l\'éditeur graphe', () => {
  // Deux natures, pas une de plus. Le DTO n'en porte pas d'autre : `stageType`
  // et `actionType` sont des chaînes libres venues du pack.
  assert.deepEqual(NODE_ICON_VOCABULARY[WORKSPACE_MODE_ADVANCED], {
    stage: ICON_FULLSCREEN,
    action: ICON_WAYPOINTS,
  });
});

test('un Dossier replié est le seul état qui change un dessin', () => {
  const menu = HIERARCHICAL_NATURES.MENU;
  assert.equal(resolveNodeIconName(WORKSPACE_MODE_HIERARCHICAL, menu), ICON_FOLDER_OPEN);
  assert.equal(resolveNodeIconName(WORKSPACE_MODE_HIERARCHICAL, menu, { collapsed: true }), ICON_FOLDER);

  for (const nature of Object.values(HIERARCHICAL_NATURES)) {
    if (nature === menu) continue;
    assert.equal(
      resolveNodeIconName(WORKSPACE_MODE_HIERARCHICAL, nature, { collapsed: true }),
      resolveNodeIconName(WORKSPACE_MODE_HIERARCHICAL, nature),
      `${nature} ne doit pas changer de dessin selon le repli`,
    );
  }
});

// ── Le vocabulaire ne dit pas plus que ce que la structure porte ───────────

test('le graphe n\'emprunte aucune nature à l\'arbre', () => {
  // Replier une valeur absente sur une valeur d'arbre, ce serait inventer une
  // réponse. La table rend `null`, et c'est une réponse.
  for (const nature of Object.values(HIERARCHICAL_NATURES)) {
    if (Object.values(ADVANCED_NATURES).includes(nature)) continue;
    assert.equal(
      resolveNodeIconName(WORKSPACE_MODE_ADVANCED, nature),
      null,
      `le graphe ne connaît pas la nature « ${nature} »`,
    );
  }
});

test('l\'arbre n\'emprunte aucune nature au graphe', () => {
  assert.equal(resolveNodeIconName(WORKSPACE_MODE_HIERARCHICAL, ADVANCED_NATURES.ACTION), null);
});

test('un accueil sans projet ouvert n\'a pas de vocabulaire', () => {
  assert.equal(resolveNodeIconName(WORKSPACE_MODE_HOME, HIERARCHICAL_NATURES.ROOT), null);
});

test('le message de fin prend sa variante nuit de l\'option, pas d\'un type', () => {
  assert.equal(hierarchicalNatureOf('end-node'), HIERARCHICAL_NATURES.END_NODE);
  assert.equal(hierarchicalNatureOf('end-node', { night: true }), HIERARCHICAL_NATURES.END_NIGHT);
  assert.equal(resolveNodeIconName(WORKSPACE_MODE_HIERARCHICAL, hierarchicalNatureOf('end-node', { night: true })), ICON_MOON);
  // L'option nuit ne déteint sur aucune autre nature.
  assert.equal(hierarchicalNatureOf('story', { night: true }), HIERARCHICAL_NATURES.STORY);
});

test('un type qui n\'est pas une nature ne reçoit aucun repli d\'office', () => {
  // Le repli appartient à la surface, pas à la table : c'est ce qui permet à
  // l'arbre de replier sur la lune et à l'en-tête de réglages sur l'accueil.
  assert.equal(hierarchicalNatureOf('multi'), null);
  assert.equal(hierarchicalNatureOf(undefined), null);
});

// ── Le pinceau peint exactement la table ──────────────────────────────────

test('chaque nom de la table est peint, et rien d\'autre ne l\'est', async () => {
  const source = await readSource('src/components/icons/NodeIcon.jsx');
  const constants = {
    ICON_HOUSE, ICON_FOLDER, ICON_FOLDER_OPEN, ICON_MUSIC, ICON_FILE_ARCHIVE,
    ICON_ARROW_RIGHT, ICON_SQUARE, ICON_FULLSCREEN, ICON_MOON, ICON_WAYPOINTS,
  };
  const painted = [...source.matchAll(/\[(ICON_[A-Z_]+)\]:\s*(\w+),/g)]
    .map(([, constant, component]) => {
      assert.ok(constant in constants, `${constant} n'est pas un nom du vocabulaire`);
      return { name: constants[constant], component };
    });

  assert.deepEqual(
    painted.map((entry) => entry.name).sort(),
    listVocabularyIconNames(),
    'le pinceau et la table doivent porter exactement les mêmes dessins',
  );

  const shared = await readSource(SHARED_ICON_SET);
  for (const { name, component } of painted) {
    assert.match(
      shared,
      new RegExp(`^export const ${component} = createLocalLucideIcon\\(`, 'm'),
      `le dessin « ${name} » doit venir du jeu partagé, via ${component}`,
    );
  }
});

// ── Aucun jeu d'icônes en double ──────────────────────────────────────────

test('aucun jeu d\'icônes en double ne subsiste', async () => {
  const sets = await collectIconSets();
  assert.deepEqual(
    unexplainedSets(sets).map((set) => set.file),
    [],
    'tout fichier qui dessine des icônes doit être le jeu partagé ou une famille nommée avec sa raison',
  );
  const shared = sets.find((set) => set.file === SHARED_ICON_SET);
  assert.ok(shared && shared.shapes > 100, 'le jeu partagé porte le vocabulaire de l\'application');
});

test('le jeu de l\'arbre a disparu, il n\'est pas gardé « au cas où »', async () => {
  await assert.rejects(
    () => readSource('src/components/TreePanel/TreeIcons.jsx'),
    /ENOENT/,
    'un second jeu conservé redevient un jeu utilisé',
  );
});

// ── Les surfaces peignent la table, elles ne la refont pas ────────────────

const SURFACES = [
  'src/components/TreePanel/TreeNode.jsx',
  'src/components/TreePanel/TreeDragOverlay.jsx',
  'src/components/diagram/FullDiagramNode.jsx',
  'src/components/diagram/FullDiagramTree.jsx',
  'src/components/editors/story/AfterPlaySection.jsx',
  'src/workspace/SettingsPanelHeader.jsx',
  'src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx',
];

test('les six surfaces de l\'arbre et celle du graphe passent par la table', async () => {
  for (const surface of SURFACES) {
    const source = await readSource(surface);
    assert.match(source, /import \{ NodeIcon \}/, `${surface} doit peindre la table`);
  }
});

test('la liste du graphe porte un dessin, plus une lettre dans un carré', async () => {
  const source = await readSource('src/components/AdvancedGraphCanvas/GraphSearchPanel.jsx');
  assert.match(
    source,
    /<NodeIcon workspaceMode=\{WORKSPACE_MODE_ADVANCED\} nature=\{result\.kind\} \/>/,
    'chaque ligne porte le dessin de sa nature',
  );
  assert.doesNotMatch(source, /advanced-search__badge/, 'la pastille de texte a disparu');

  const styles = await readSource('src/components/AdvancedGraphCanvas/AdvancedGraphCanvas.css');
  assert.doesNotMatch(styles, /advanced-search__badge/, 'et sa mise en forme avec elle');
});

test('l\'arbre garde la boîte d\'icône qu\'il avait', async () => {
  // La densité et l'alignement des lignes tiennent à cette boîte : le jeu
  // partagé dessine sur une grille de 24, l'arbre peint à 14 px comme avant.
  const styles = await readSource('src/components/TreePanel/TreePanel.css');
  assert.match(styles, /\.ti-icon svg \{\s*width: 14px;\s*height: 14px;\s*\}/);
});
