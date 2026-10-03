// L'historique des révélations volontaires.
//
// Ce que ces essais tiennent avant tout : que cet historique reste **distinct
// de l'annulation d'édition**. Les deux se ressemblent de loin — on « revient
// en arrière » dans les deux cas — et les confondre ferait défaire une
// correction en voulant revenir sur ses pas.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canGoBack,
  canGoForward,
  createRevealHistory,
  currentVisit,
  goBack,
  goForward,
  pruneMissing,
  recordVisit,
} from '../src/store/advancedGraphView/revealHistory.js';

const paths = (history) => history.visits.map((visit) => visit.path);

test('un historique neuf ne mène nulle part', () => {
  const history = createRevealHistory();
  assert.equal(currentVisit(history), null);
  assert.equal(canGoBack(history), false);
  assert.equal(canGoForward(history), false);
  assert.deepEqual(goBack(history).visit, null);
  assert.deepEqual(goForward(history).visit, null);
});

test('les visites s’empilent dans leur ordre', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/b');
  history = recordVisit(history, '/c');
  assert.deepEqual(paths(history), ['/a', '/b', '/c']);
  assert.equal(currentVisit(history).path, '/c');
  assert.equal(canGoBack(history), true);
  assert.equal(canGoForward(history), false);
});

test('révéler deux fois le même nœud ne l’empile pas deux fois', () => {
  // Sans cette règle, un double clic obligeait à appuyer deux fois sur
  // Précédent pour bouger d'un seul cran.
  let history = createRevealHistory();
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/a');
  assert.deepEqual(paths(history), ['/a']);
  assert.equal(canGoBack(history), false);
});

test('le cadrage le plus récent du nœud courant est conservé', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a', { x: 1, y: 1, zoom: 1 });
  history = recordVisit(history, '/a', { x: 9, y: 9, zoom: 2 });
  assert.deepEqual(paths(history), ['/a']);
  assert.deepEqual(currentVisit(history).viewport, { x: 9, y: 9, zoom: 2 });
});

test('Précédent et Suivant parcourent l’historique sans le réécrire', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a', { x: 0, y: 0, zoom: 1 });
  history = recordVisit(history, '/b', { x: 10, y: 0, zoom: 1 });
  history = recordVisit(history, '/c', { x: 20, y: 0, zoom: 1 });

  const first = goBack(history);
  assert.equal(first.visit.path, '/b');
  assert.deepEqual(first.visit.viewport, { x: 10, y: 0, zoom: 1 });
  const second = goBack(first.history);
  assert.equal(second.visit.path, '/a');
  assert.equal(canGoBack(second.history), false);
  assert.equal(canGoForward(second.history), true);

  // La pile est intacte : reculer ne retire rien.
  assert.deepEqual(paths(second.history), ['/a', '/b', '/c']);
  const ahead = goForward(second.history);
  assert.equal(ahead.visit.path, '/b');
  assert.equal(goForward(ahead.history).visit.path, '/c');
});

test('une nouvelle visite après Précédent coupe la suite', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/b');
  history = recordVisit(history, '/c');
  history = goBack(history).history;           // sur /b
  history = recordVisit(history, '/z');
  assert.deepEqual(paths(history), ['/a', '/b', '/z']);
  assert.equal(canGoForward(history), false, '/c est abandonné, comme dans une navigation');
});

test('un chemin vide ou absent n’entre pas dans l’historique', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '');
  history = recordVisit(history, null);
  history = recordVisit(history, undefined);
  assert.deepEqual(paths(history), []);
});

test('une cible supprimée est retirée proprement, sans vider l’historique', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/b');
  history = recordVisit(history, '/c');
  const alive = new Set(['/a', '/c']);
  const pruned = pruneMissing(history, (path) => alive.has(path));
  assert.deepEqual(paths(pruned), ['/a', '/c']);
  assert.equal(currentVisit(pruned).path, '/c', 'la place de l’auteur est conservée');
});

test('si tout ce qui précédait a disparu, la place tombe sur le premier survivant', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/b');
  history = recordVisit(history, '/c');
  history = goBack(history).history;           // sur /b
  const alive = new Set(['/c']);
  const pruned = pruneMissing(history, (path) => alive.has(path));
  assert.deepEqual(paths(pruned), ['/c']);
  assert.equal(currentVisit(pruned).path, '/c');
  assert.equal(canGoBack(pruned), false);
});

test('un historique dont plus rien ne survit redevient vide', () => {
  let history = createRevealHistory();
  history = recordVisit(history, '/a');
  history = recordVisit(history, '/b');
  const pruned = pruneMissing(history, () => false);
  assert.deepEqual(paths(pruned), []);
  assert.equal(currentVisit(pruned), null);
  assert.equal(canGoBack(pruned), false);
  assert.equal(canGoForward(pruned), false);
});

test('l’historique est immuable : enregistrer rend une nouvelle valeur', () => {
  // C'est ce qui permet de le tenir dans un état React sans copie défensive,
  // et ce qui garantit qu'un enregistrement ne mute pas ce qu'un rendu lit.
  const first = recordVisit(createRevealHistory(), '/a');
  const second = recordVisit(first, '/b');
  assert.notEqual(first, second);
  assert.deepEqual(paths(first), ['/a'], 'la valeur précédente n’a pas bougé');
  assert.throws(() => { second.visits.push({ path: '/x' }); }, TypeError);
});

test('un changement de projet vide l’historique par construction', () => {
  // Il n'y a rien à « effacer » : l'appelant repart d'un historique neuf, et
  // c'est la seule façon de ne pas garder les chemins d'un document fermé.
  let history = recordVisit(createRevealHistory(), '/a');
  history = recordVisit(history, '/b');
  assert.deepEqual(paths(createRevealHistory()), []);
  assert.deepEqual(paths(history), ['/a', '/b'], 'l’ancien reste inchangé');
});

// --- La règle de tri, telle que l'atelier l'applique -----------------------

// L'atelier n'a pas inventé de signal pour distinguer un parcours de liste
// d'une révélation : la liste portait déjà `center: false` pour ses flèches,
// qui changent le descendant actif sans déplacer la caméra, et `center: true`
// pour un résultat validé ou cliqué. Cet essai fixe cette règle, parce qu'elle
// est la frontière exacte : pas les frames de caméra, ni le survol, ni les
// flèches de liste, ni les pas automatiques de simulation.
function revealPath(history, path, options) {
  return options?.center !== false ? recordVisit(history, path, null) : history;
}

test('les flèches de la liste ne laissent aucune trace dans l’historique', () => {
  let history = createRevealHistory();
  history = revealPath(history, '/a', { center: false });
  history = revealPath(history, '/b', { center: false });
  history = revealPath(history, '/c', { center: false });
  assert.deepEqual(paths(history), [], 'parcourir la liste n’est pas révéler');
});

test('un résultat validé, un clic ou un lien entrent dans l’historique', () => {
  let history = createRevealHistory();
  history = revealPath(history, '/a', { center: false });   // flèche
  history = revealPath(history, '/a', { center: true });    // Entrée
  history = revealPath(history, '/b', { center: false });   // flèche
  history = revealPath(history, '/c');                      // lien d’inspecteur
  assert.deepEqual(paths(history), ['/a', '/c']);
});
