// Où atterrit un nœud créé, quand le point demandé est déjà occupé.
//
// Le défaut corrigé est l'empilement **exact** : dix créations depuis l'en-tête
// envoient dix fois le centre de la vue, et dix cartes au même point sont
// indiscernables — seule celle du dessus reçoit le pointeur.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NODE_CASCADE_CLEARANCE,
  NODE_CASCADE_STEP_X,
  NODE_CASCADE_STEP_Y,
  freeNodeSpot,
  pruneReservedSpots,
  releaseReservedSpots,
} from '../src/store/advancedAuthoring/nodePlacement.js';

const at = (x, y) => ({ node: { layout: { x, y } } });
const cran = (rank) => ({ x: NODE_CASCADE_STEP_X * rank, y: NODE_CASCADE_STEP_Y * rank });

test('le pas écarte assez pour qu’un Écran et une Action se dégagent', () => {
  // 52 + 26 sur l'axe des x, 40 + 26 sur celui des y : les demi-silhouettes de
  // `NODE_GEOMETRY`. Le dégagement, lui, reste bien plus court — c'est ce qui
  // distingue « au même endroit » de « qui se recouvre ».
  assert.equal(NODE_CASCADE_STEP_X, 78);
  assert.equal(NODE_CASCADE_STEP_Y, 66);
  assert.ok(NODE_CASCADE_CLEARANCE < NODE_CASCADE_STEP_Y);
});

test('un point libre est employé tel quel', () => {
  assert.deepEqual(freeNodeSpot([], { x: 120, y: -40 }), { x: 120, y: -40 });
  assert.deepEqual(
    freeNodeSpot([at(5000, 5000)], { x: 0, y: 0 }),
    { x: 0, y: 0 },
    'un nœud lointain ne pousse rien',
  );
});

test('un voisin qui recouvre sans se superposer ne pousse pas la carte', () => {
  // Le cas qui compte sur un pack fourni : un clic droit en zone dense doit
  // poser le nœud **où l'auteur a visé**. Seul l'empilement franc le déplace.
  const voisin = at(NODE_CASCADE_CLEARANCE + 1, 0);
  assert.deepEqual(freeNodeSpot([voisin], { x: 0, y: 0 }), { x: 0, y: 0 });
});

test('un point occupé décale d’un cran, en diagonale', () => {
  assert.deepEqual(freeNodeSpot([at(0, 0)], { x: 0, y: 0 }), cran(1));
});

test('dix créations au même point donnent dix places distinctes', () => {
  // Le cas de l'auteur : la volée reste groupée, mais chaque carte montre son
  // bord et peut être attrapée.
  const entries = [];
  const spots = [];
  for (let n = 0; n < 10; n += 1) {
    const spot = freeNodeSpot(entries, { x: 0, y: 0 });
    spots.push(spot);
    entries.push(at(spot.x, spot.y));
  }
  assert.equal(new Set(spots.map(({ x, y }) => `${x}:${y}`)).size, 10);
  assert.deepEqual(spots.at(-1), cran(9));
});

test('les places réservées comptent comme occupées', () => {
  // Un geste fait un aller-retour par Rust avant que la vue soit relue. Sans
  // cette mémoire, deux clics rapides posent deux cartes au même endroit.
  assert.deepEqual(
    freeNodeSpot([], { x: 0, y: 0 }, { reserved: [{ x: 0, y: 0 }] }),
    cran(1),
  );
});

test('la cascade saute par-dessus ce qui la gêne', () => {
  const entries = [at(0, 0), at(cran(1).x, cran(1).y)];
  assert.deepEqual(freeNodeSpot(entries, { x: 0, y: 0 }), cran(2));
});

test('cascade saturée : le point demandé vaut mieux que rien', () => {
  // Il faudrait soixante-cinq nœuds posés sur sa diagonale. Ne pas créer serait
  // un refus que l'auteur n'a pas demandé.
  const entries = Array.from({ length: 65 }, (unused, rank) => at(cran(rank).x, cran(rank).y));
  assert.deepEqual(freeNodeSpot(entries, { x: 0, y: 0 }), { x: 0, y: 0 });
});

test('un point inexploitable ne fabrique aucune place', () => {
  assert.equal(freeNodeSpot([], null), null);
  assert.equal(freeNodeSpot([], { x: Number.NaN, y: 0 }), null);
});

test('une disposition sans coordonnées lisibles n’occupe rien', () => {
  const entries = [{ node: {} }, { node: { layout: {} } }, at(Number.NaN, 0), null];
  assert.deepEqual(freeNodeSpot(entries, { x: 0, y: 0 }), { x: 0, y: 0 });
});

test('une réservation disparaît dès que l’index porte son nœud', () => {
  const reserved = [{ x: 0, y: 0 }, cran(1)];
  // Seule la première a atterri : l'autre est encore en vol.
  assert.deepEqual(pruneReservedSpots(reserved, [at(0, 0)]), [cran(1)]);
  assert.deepEqual(pruneReservedSpots(reserved, [at(0, 0), at(cran(1).x, cran(1).y)]), []);
  assert.deepEqual(pruneReservedSpots([], [at(0, 0)]), []);
});

// Un geste refusé, périmé ou retenu ne pose aucun nœud : sa place ne serait
// jamais purgée par l'index, et la création suivante au même point se
// décalerait d'un cran pour rien.
test('une réservation se rend quand le geste n’aboutit pas', () => {
  const reserved = [{ x: 0, y: 0 }, cran(1), cran(2)];
  assert.deepEqual(releaseReservedSpots(reserved, [cran(1)]), [{ x: 0, y: 0 }, cran(2)]);
  assert.deepEqual(releaseReservedSpots(reserved, [cran(1), cran(2)]), [{ x: 0, y: 0 }]);
  assert.deepEqual(releaseReservedSpots(reserved, []), reserved);
  // Deux réservations au même point en vol : n'en rendre qu'une.
  assert.deepEqual(releaseReservedSpots([cran(1), cran(1)], [cran(1)]), [cran(1)]);
  assert.deepEqual(releaseReservedSpots(null, [cran(1)]), []);
});
