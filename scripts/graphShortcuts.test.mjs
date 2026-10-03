// Les raccourcis de l'éditeur graphe.
//
// Ils ne sont plus écrits dans le module du graphe : ils viennent de la table
// commune, portées « Sélection » et « Éditeur graphe ». Ces essais portent sur
// deux choses — que chaque frappe désigne la bonne commande de la table, et
// surtout ce que le graphe **laisse passer** : la recherche de nœuds et les
// champs de l'inspecteur partagent la même fenêtre, et leur voler une frappe
// serait le seul vrai dégât possible.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  GRAPH_WRITING_SHORTCUTS,
  graphShortcutFor,
} = await import('../src/store/advancedAuthoring/graphShortcuts.js');
const { isEditableTarget } = await import('../src/utils/shortcutTarget.js');
const { DEFAULT_SHORTCUTS } = await import('../src/store/keyboardShortcuts.js');

const press = (key, extra = {}) => ({
  key,
  code: extra.code ?? (/^[a-z]$/i.test(key ?? '') ? `Key${key.toUpperCase()}` : key),
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  target: { tagName: 'DIV' },
  ...extra,
});
const command = (key, extra = {}) => press(key, { ctrlKey: true, ...extra });
const shortcutFor = (event, options = {}) => graphShortcutFor(event, { shortcuts: DEFAULT_SHORTCUTS, ...options });

test('les commandes de la sélection sont celles de la table commune', () => {
  assert.equal(shortcutFor(command('c')), 'selectionCopy');
  assert.equal(shortcutFor(command('x')), 'selectionCut');
  assert.equal(shortcutFor(command('v')), 'selectionPaste');
  assert.equal(shortcutFor(command('d')), 'selectionDuplicate');
  assert.equal(shortcutFor(press('Delete', { code: 'Delete' })), 'selectionDelete');
  assert.equal(shortcutFor(press('Backspace', { code: 'Backspace' })), 'selectionDelete');
  assert.equal(shortcutFor(press('F2', { code: 'F2' })), 'selectionRename');
  // La casse suit le clavier, pas la touche : Verr.Maj ne désarme rien.
  assert.equal(shortcutFor(command('C')), 'selectionCopy');
});

test('les commandes propres au graphe sont reconnues', () => {
  assert.equal(shortcutFor(press('+', { code: 'NumpadAdd' })), 'graphZoomIn');
  assert.equal(shortcutFor(press('-', { code: 'NumpadSubtract' })), 'graphZoomOut');
  assert.equal(shortcutFor(press('0', { code: 'Digit0' })), 'graphFit');
  assert.equal(shortcutFor(press('ArrowLeft', { code: 'ArrowLeft', altKey: true })), 'graphVisitBack');
  assert.equal(shortcutFor(press('ArrowRight', { code: 'ArrowRight', altKey: true })), 'graphVisitForward');
  assert.equal(shortcutFor(press('e')), 'graphCreateStage');
  assert.equal(shortcutFor(press('a')), 'graphCreateAction');
  assert.equal(shortcutFor(press('m')), 'graphToggleOverview');
  assert.equal(shortcutFor(command('r', { shiftKey: true, key: 'R' })), 'graphArrange');
});

test('les touches du zoom suivent le caractère, sur un AZERTY comme sur un QWERTY', () => {
  // AZERTY : `+` demande Maj sur la touche `=`, et `-` est sur la touche `6`.
  assert.equal(shortcutFor(press('+', { code: 'Equal', shiftKey: true })), 'graphZoomIn');
  assert.equal(shortcutFor(press('-', { code: 'Digit6' })), 'graphZoomOut');
  // QWERTY : la touche `=` porte `+` avec Maj, `=` sans.
  assert.equal(shortcutFor(press('=', { code: 'Equal' })), 'graphZoomIn');
  assert.equal(shortcutFor(press('-', { code: 'Minus' })), 'graphZoomOut');
  // AZERTY : la touche `0` tape `à` sans Maj ; c'est la position qui compte.
  assert.equal(shortcutFor(press('à', { code: 'Digit0' })), 'graphFit');
});

test('une lettre se reconnaît au caractère tapé, pas à la position QWERTY', () => {
  // Sur un AZERTY, la touche de code `KeyQ` tape `a`, et celle de code `KeyA`
  // tape `q`. Seul le caractère `a` crée une Action.
  assert.equal(shortcutFor(press('a', { code: 'KeyQ' })), 'graphCreateAction');
  assert.equal(shortcutFor(press('q', { code: 'KeyA' })), null);
});

test('Alt et Maj changent la commande : aucune touche nue n’est confondue', () => {
  assert.equal(shortcutFor(command('c', { altKey: true })), null);
  assert.equal(shortcutFor(command('c', { shiftKey: true, key: 'C' })), null);
  assert.equal(shortcutFor(press('c')), null, 'c seul ne copie pas');
  assert.equal(shortcutFor(command('k')), null);
  assert.equal(shortcutFor(press('ArrowLeft', { code: 'ArrowLeft' })), null, 'une flèche seule ne remonte pas l’historique');
});

test('une frappe destinée à un champ lui est rendue', () => {
  // La recherche de nœuds et les champs de l'inspecteur partagent la fenêtre :
  // une lettre s'y tape, et un Ctrl+C y copie du texte.
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) {
    assert.equal(shortcutFor(command('c', { target: { tagName } })), null, tagName);
    assert.equal(shortcutFor(press('e', { target: { tagName } })), null, `${tagName} : E s’y tape`);
    assert.equal(shortcutFor(press('Delete', { code: 'Delete', target: { tagName } })), null);
  }
  assert.equal(
    shortcutFor(command('x', { target: { tagName: 'DIV', isContentEditable: true } })),
    null,
  );
  assert.equal(isEditableTarget({ tagName: 'input' }), true, 'la casse de la balise ne compte pas');
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget(null), false);
});

test('un dialogue ouvert, une écoute en cours ou une frappe déjà consommée reprennent le clavier', () => {
  for (const event of [command('c'), press('Delete', { code: 'Delete' }), press('e'), press('m')]) {
    assert.equal(shortcutFor(event, { blocked: true }), null, event.key);
    assert.equal(shortcutFor({ ...event, defaultPrevented: true }), null, `${event.key} déjà consommée`);
  }
});

test('ce qui écrit dans le document attend la fin du geste en cours, pas les lectures', () => {
  // Copier, zoomer, revenir au nœud visité sont des **lectures** : elles
  // n'écrivent rien, et restent offertes. C'est la même règle que les entrées
  // du menu contextuel, et elle ne doit pas diverger.
  const suspended = { editingDisabled: true };
  assert.equal(shortcutFor(command('c'), suspended), 'selectionCopy');
  assert.equal(shortcutFor(press('+', { code: 'NumpadAdd' }), suspended), 'graphZoomIn');
  assert.equal(shortcutFor(press('m'), suspended), 'graphToggleOverview');
  for (const [event, id] of [
    [command('x'), 'selectionCut'],
    [command('v'), 'selectionPaste'],
    [command('d'), 'selectionDuplicate'],
    [press('Delete', { code: 'Delete' }), 'selectionDelete'],
    [press('F2', { code: 'F2' }), 'selectionRename'],
    [press('e'), 'graphCreateStage'],
    [press('a'), 'graphCreateAction'],
  ]) {
    assert.ok(GRAPH_WRITING_SHORTCUTS.includes(id), id);
    assert.equal(shortcutFor(event, suspended), null, id);
  }
});

test('une commande reconfigurée répond à sa nouvelle touche, plus à l’ancienne', () => {
  const shortcuts = {
    ...DEFAULT_SHORTCUTS,
    graphCreateStage: { ctrl: false, shift: false, alt: false, meta: false, key: 'n', code: 'KeyN' },
  };
  assert.equal(graphShortcutFor(press('n'), { shortcuts }), 'graphCreateStage');
  assert.equal(graphShortcutFor(press('e'), { shortcuts }), null);
});

test('une frappe sans évènement ne décide de rien', () => {
  assert.equal(shortcutFor(null), null);
  assert.equal(shortcutFor(press(undefined, { code: undefined })), null);
});
