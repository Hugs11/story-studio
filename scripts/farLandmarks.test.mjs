// Les repères du régime éloigné : la règle partagée par la couche HTML et la
// capture de recette.
//
// Ces essais existent parce que la recette Tauri a mesuré ce que les essais
// sous Node ne pouvaient pas voir : chaque nœud à corriger portait son nom, et
// sur le profil p90 de 795 nœuds cela faisait 508 paires de noms qui se
// recouvrent — 85 257 sur le maximum de 9 121, avec des anneaux couvrant 163 %
// de la scène. Tous les contrôles de l'époque passaient : l'entrée était bien
// présente, son anneau bien à 56 px, son libellé bien « ENTRÉE ». L'écran, lui,
// était un aplat jaune. Ce que ces essais tiennent, c'est la règle qui borne le
// dessin.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calloutLayout,
  farLandmarkMarks,
  landmarkKind,
  LANDMARK_KINDS,
} from '../src/components/AdvancedGraphCanvas/farLandmarks.js';

const node = (path, extra = {}) => ({
  path, kind: 'stage', label: path, x: 100, y: 100, width: 10, height: 6, degree: 0, ...extra,
});

const byPath = (marks) => new Map(marks.map((mark) => [mark.node.path, mark]));

test('seuls les repères de navigation survivent au régime éloigné', () => {
  assert.equal(landmarkKind(node('/a', { isEntry: true, diagnosed: true })), LANDMARK_KINDS.ENTRY);
  assert.equal(landmarkKind(node('/b', { selected: true, diagnosed: true })), LANDMARK_KINDS.SELECTED);
  assert.equal(landmarkKind(node('/c', { diagnosed: true })), null);
  assert.equal(landmarkKind(node('/d', { isolated: true })), null);
  assert.equal(landmarkKind(node('/e', { noIncoming: true })), null);
  assert.equal(landmarkKind(node('/f', { isHub: true })), LANDMARK_KINDS.HUB);
  assert.equal(landmarkKind(node('/g', {})), null, 'un nœud sans rôle ne porte aucun repère');
  // « Inaccessible » reste volontairement hors des repères : sur un pack dont
  // l'entrée est cassée, il désignerait presque tout le graphe.
  assert.equal(landmarkKind(node('/h', { unreachable: true })), null);
  assert.equal(landmarkKind(node('/i', { deadEnd: true })), null, 'une fin de parcours n’est pas un défaut');
});

test('un nœud à corriger ne laisse aucune marque sur le graphe', () => {
  assert.deepEqual(farLandmarkMarks([
    node('/faute', { diagnosed: true, label: 'Écran 3867' }),
  ]), []);
});

test('l’entrée garde son étiquette, et aucun nom ne se pose sur son anneau', () => {
  // Un carrefour voisin de l'entrée gardait son nom, posé en travers de
  // l'anneau de 56 px : c'est ce que montrait la vue finale d'un pack dense.
  // Il garde son point, sans nom ; l'entrée ne cède rien.
  const marks = byPath(farLandmarkMarks([
    node('/entree', { isEntry: true, label: 'Accueil' }),
    node('/carrefour', { isHub: true, degree: 31, label: 'Carrefour', x: 110, y: 104 }),
  ]));
  assert.equal(marks.get('/entree').label, 'RACINE');
  assert.equal(marks.get('/entree').isTag, true);
  assert.equal(marks.get('/carrefour').label, null);

  // Hors de l'anneau et de l'étiquette, un carrefour garde le sien.
  const apart = byPath(farLandmarkMarks([
    node('/entree', { isEntry: true, label: 'Accueil' }),
    node('/carrefour', { isHub: true, degree: 31, label: 'Carrefour', x: 400, y: 100 }),
  ]));
  assert.equal(apart.get('/carrefour').label, 'Carrefour · 31 liens');
  assert.equal(apart.get('/carrefour').isTag, false);
});

test('de deux carrefours voisins, le plus relié garde sa place et l’autre en cherche une', () => {
  // Deux carrefours proches faisaient se chevaucher leurs noms. Le plus relié
  // se pose dessous, à la place attendue ; l'autre prend la suivante qui est
  // libre au lieu de perdre son nom.
  const marks = byPath(farLandmarkMarks([
    node('/petit', { isHub: true, degree: 12, label: 'Carrefour modeste', x: 104, y: 100 }),
    node('/grand', { isHub: true, degree: 31, label: 'Carrefour majeur', x: 100, y: 100 }),
  ]));
  assert.equal(marks.get('/grand').label, 'Carrefour majeur · 31 liens');
  assert.equal(marks.get('/grand').placement, 'below');
  assert.equal(marks.get('/petit').label, 'Carrefour modeste · 12 liens');
  assert.equal(marks.get('/petit').placement, 'above');
});

test('un nom sans aucune place libre cède, et le survol le nomme encore', () => {
  // Quatre voisins occupent dessous, dessus, droite et gauche du dernier.
  const marks = byPath(farLandmarkMarks([
    node('/a', { isHub: true, degree: 40, label: 'Alpha', x: 100, y: 100 }),
    node('/b', { isHub: true, degree: 39, label: 'Bravo', x: 100, y: 128 }),
    node('/c', { isHub: true, degree: 38, label: 'Charlie', x: 100, y: 72 }),
    node('/d', { isHub: true, degree: 37, label: 'Delta', x: 128, y: 100 }),
    node('/e', { isHub: true, degree: 36, label: 'Écho', x: 72, y: 100 }),
  ]));
  assert.equal(marks.get('/a').label, null);
  assert.equal(marks.get('/a').placement, null);
  assert.equal(marks.get('/a').title, 'Alpha · 40 liens');
  assert.equal(marks.get('/a').kind, LANDMARK_KINDS.HUB, 'sa marque reste dessinée');
});

test('les grands menus serrés contre la racine gardent leur nom, à côté', () => {
  // La forme d'un pack réel à 3 % : la racine, puis ses menus en colonne juste
  // à sa droite. Dessous, chaque nom tombait sur l'étiquette RACINE ou sur la
  // marque du menu suivant, et les quatre disparaissaient ensemble.
  const marks = byPath(farLandmarkMarks([
    node('/racine', { isEntry: true, label: 'Cover node', x: 100, y: 100 }),
    node('/m1', { isHub: true, degree: 210, label: 'Menu histoires', x: 160, y: 60 }),
    node('/m2', { isHub: true, degree: 90, label: 'Menu comptines', x: 160, y: 85 }),
    node('/m3', { isHub: true, degree: 40, label: 'Menu saisons', x: 160, y: 110 }),
    node('/m4', { isHub: true, degree: 12, label: 'Menu bonus', x: 160, y: 135 }),
  ]));
  for (const path of ['/m1', '/m2', '/m3', '/m4']) {
    assert.notEqual(marks.get(path).label, null, `${path} garde son nom`);
  }
  assert.equal(marks.get('/m3').placement, 'right');
  assert.equal(marks.get('/racine').label, 'RACINE');
});

test('deux carrefours assez éloignés gardent tous deux leur nom', () => {
  const marks = byPath(farLandmarkMarks([
    node('/un', { isHub: true, degree: 31, label: 'Nord', x: 100, y: 100 }),
    node('/deux', { isHub: true, degree: 30, label: 'Sud', x: 600, y: 400 }),
  ]));
  assert.equal(marks.get('/un').label, 'Nord · 31 liens');
  assert.equal(marks.get('/deux').label, 'Sud · 30 liens');
});

test('à degré égal, le chemin tranche : deux lectures rendent le même dessin', () => {
  const nodes = [
    node('/b', { isHub: true, degree: 20, label: 'Bravo', x: 100, y: 100 }),
    node('/a', { isHub: true, degree: 20, label: 'Alpha', x: 104, y: 100 }),
  ];
  const first = byPath(farLandmarkMarks(nodes));
  const second = byPath(farLandmarkMarks([...nodes].reverse()));
  assert.equal(first.get('/a').placement, 'below');
  assert.equal(first.get('/b').placement, 'above');
  for (const path of ['/a', '/b']) {
    assert.equal(second.get(path).label, first.get(path).label);
    assert.equal(second.get(path).placement, first.get(path).placement);
  }
});

test('la sélection garde son nom aux zooms où les autres tombent', () => {
  const marks = byPath(farLandmarkMarks([
    node('/choisi', { selected: true, diagnosed: true, label: 'Écran choisi' }),
  ]));
  assert.equal(marks.get('/choisi').kind, LANDMARK_KINDS.SELECTED);
  assert.equal(marks.get('/choisi').label, 'Écran choisi');
});

test('un nom vide ou absent ne produit pas de marque nommée', () => {
  const marks = byPath(farLandmarkMarks([
    node('/vide', { selected: true, label: '' }),
    node('/absent', { selected: true, label: null, x: 400, y: 400 }),
  ]));
  assert.equal(marks.get('/vide').label, null);
  assert.equal(marks.get('/absent').label, null);
});

test('une nuée de nœuds à corriger ne laisse que les repères de navigation', () => {
  // Le cas qui a motivé la règle : 3 752 nœuds diagnostiqués sur le plus gros
  // projet mesuré. Aucun ne porte de nom ; seuls l'entrée, la sélection et les carrefours
  // en ont un.
  const nodes = Array.from({ length: 3752 }, (_, index) => node(`/w${index}`, {
    diagnosed: true, x: (index % 60) * 20, y: Math.floor(index / 60) * 20,
  }));
  nodes.push(node('/entree', { isEntry: true, label: 'Accueil', x: 1400, y: 900 }));
  nodes.push(node('/hub', { isHub: true, degree: 27, label: 'Action 20', x: 1400, y: 40 }));
  const marks = farLandmarkMarks(nodes);
  const named = marks.filter((mark) => mark.label !== null);
  assert.equal(marks.length, 2, 'les diagnostics sont regroupés dans la pastille de la barre');
  assert.deepEqual(
    named.map((mark) => mark.label).sort(),
    ['Action 20 · 27 liens', 'RACINE'],
    'seuls l’entrée et le carrefour écrivent quelque chose',
  );
});

// La forme du pack Toudou à 3 % : la racine au bord gauche, ses menus serrés
// dans une colonne étroite, et une fenêtre large tout autour.
const narrowPack = () => [
  node('/racine', { isEntry: true, label: 'Cover node', x: 500, y: 300 }),
  node('/m1', { isHub: true, degree: 24, label: 'Action node', x: 530, y: 290 }),
  node('/m2', { isHub: true, degree: 20, label: 'Menu comptines', x: 528, y: 296 }),
  node('/m3', { isHub: true, degree: 12, label: 'Menu saisons', x: 532, y: 304 }),
  node('/m4', { isHub: true, degree: 9, label: 'Menu bonus', x: 529, y: 310 }),
];
const wide = { bounds: { x1: 500, y1: 100, x2: 560, y2: 500 }, viewport: { width: 1300, height: 700 } };

test('avec de la marge, chaque carrefour a son étiquette reliée à son point', () => {
  const marks = byPath(farLandmarkMarks(narrowPack(), wide));
  for (const path of ['/m1', '/m2', '/m3', '/m4']) {
    const mark = marks.get(path);
    assert.equal(mark.placement, 'callout', `${path} est rangé dans la marge`);
    assert.notEqual(mark.label, null);
    // L'étiquette est hors de la boîte du graphe : elle ne se pose pas sur la structure.
    assert.ok(mark.callout.x > wide.bounds.x2 || mark.callout.x < wide.bounds.x1);
  }
  // La racine garde son étiquette contre son anneau.
  assert.equal(marks.get('/racine').label, 'RACINE');
  assert.equal(marks.get('/racine').callout, null);
});

test('les étiquettes d’un même côté suivent l’ordre de leurs points et ne se chevauchent pas', () => {
  const marks = farLandmarkMarks(narrowPack(), wide).filter((mark) => mark.callout);
  for (const side of ['left', 'right']) {
    const column = marks.filter((mark) => mark.callout.side === side)
      .sort((left, right) => left.node.y - right.node.y);
    for (let position = 1; position < column.length; position += 1) {
      const gap = column[position].callout.y - column[position - 1].callout.y;
      assert.ok(gap >= 16, `${side} : ${gap} px entre deux étiquettes`);
    }
  }
});

test('sans marge, les noms reviennent contre leur point', () => {
  const full = { bounds: { x1: 10, y1: 10, x2: 1290, y2: 690 }, viewport: { width: 1300, height: 700 } };
  const marks = byPath(farLandmarkMarks([
    node('/un', { isHub: true, degree: 31, label: 'Nord', x: 100, y: 100 }),
  ], full));
  assert.equal(marks.get('/un').callout, null);
  assert.equal(marks.get('/un').placement, 'below');
});

test('une pile qui déborde en bas remonte dans la fenêtre', () => {
  const marks = [1, 2, 3, 4, 5].map((rank) => ({
    node: node(`/h${rank}`, { isHub: true, x: 900, y: 690 }),
  }));
  const layout = calloutLayout(marks, { x1: 800, y1: 0, x2: 950, y2: 700 }, { width: 1300, height: 700 });
  const rows = [...layout.values()].map((entry) => entry.y);
  assert.equal(rows.length, 5);
  assert.ok(Math.max(...rows) <= 700 - 12, `dernière étiquette à ${Math.max(...rows)} px`);
});
