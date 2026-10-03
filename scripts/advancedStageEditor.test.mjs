// Le panneau d'un Écran : ce que lancent ses touches, puis les listes de choix
// (Actions) où il figure, dans les lignes bordées du panneau de liste.

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  describeStageDestinations,
  describeStageMemberships,
} from '../src/store/advancedAuthoring/stageProvenance.js';
import { action, presence, stage } from './advancedViewFixtures.mjs';
import { RANDOM_OPTION_INDEX, advancedGestures } from '../src/store/projectModel/advancedGestures.js';

const { mountSurface } = await import('./chromeBench.mjs');
const { StageEditor } = await import('../src/components/AdvancedWorkspace/StageEditor.jsx');
const { StageDestinations } = await import('../src/components/AdvancedWorkspace/StageDestinations.jsx');

const stagePath = (uuid) => `/stageNodes/@uuid=${uuid}#0`;
const actionPath = (id) => `/actionNodes/@id=${id}#0`;

function transition(kind, from, to, index) {
  return {
    edgeId: `${stagePath(from)}::${kind}`,
    kind: `stage-${kind}`,
    from: stagePath(from),
    to: actionPath(to),
    optionId: null,
    ordinal: 0,
    selection: { kind: 'fixed', index },
    dangling: false,
  };
}

function option(from, ordinal, to) {
  const optionId = `${actionPath(from)}/options#${ordinal}`;
  return {
    edgeId: optionId,
    kind: 'action-option',
    from: actionPath(from),
    to: stagePath(to),
    optionId,
    ordinal,
    selection: null,
    dangling: false,
  };
}

function okTransition(to, index) {
  return {
    presence: 'value',
    actionId: to,
    actionPath: actionPath(to),
    selection: { kind: 'fixed', index },
    withinBounds: true,
    selectedOptionId: null,
    resolvedStagePath: null,
  };
}

// `depart` mène par OK à `menu` (a, b), arrive sur b. `menu` est rejoint par
// `depart` en OK et par h1, h2 en HOME. `retour` propose `depart`.
function buildIndex() {
  const stages = ['a', 'b', 'h1', 'h2'].map((uuid) => stage(uuid, {
    name: presence(`Écran ${uuid}`),
    ...(uuid === 'a' ? { okTransition: okTransition('retour', 0) } : {}),
  }));
  stages.unshift(stage('depart', {
    name: presence('Départ'),
    squareOne: presence(true),
    okTransition: okTransition('menu', 1),
  }));
  return buildGraphIndex({
    viewVersion: 1,
    entry: { status: 'unique', stagePath: stagePath('depart'), candidates: [stagePath('depart')] },
    counts: { stages: stages.length, actions: 2, options: 3, edges: 7 },
    stages,
    actions: [
      action('menu', ['a', 'b'], { name: presence('Menu') }),
      action('retour', ['depart'], { name: presence('Retour') }),
    ],
    edges: [
      transition('ok', 'depart', 'menu', 1),
      transition('home', 'h1', 'retour', 0),
      transition('home', 'h2', 'retour', 0),
      transition('ok', 'a', 'retour', 0),
      option('menu', 0, 'a'),
      option('menu', 1, 'b'),
      option('retour', 0, 'depart'),
    ],
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  });
}

test('les destinations d’un Écran : une ligne par touche, et ce sur quoi elle arrive', () => {
  const [ok, home] = describeStageDestinations(buildIndex(), stagePath('depart'));
  assert.equal(ok.slot, 'ok');
  assert.equal(ok.actionLabel, 'Menu');
  assert.equal(ok.landing.rank, 1);
  assert.equal(ok.landing.label, 'Écran b');
  assert.deepEqual(ok.options.map((row) => row.label), ['Écran a', 'Écran b']);
  assert.equal(home.slot, 'home');
  assert.equal(home.presence, 'absent');
  assert.equal(home.action, null);
});

test('les listes de choix d’un Écran : sa place, et qui ouvre chaque liste', () => {
  const [row, ...rest] = describeStageMemberships(buildIndex(), stagePath('depart'));
  assert.equal(rest.length, 0);
  assert.equal(row.actionPath, actionPath('retour'));
  assert.equal(row.rank, 0);
  assert.equal(row.count, 1, 'une liste à un seul choix reste une liste');
  assert.deepEqual(row.ok.map((opener) => opener.source.label.label), ['Écran a']);
  assert.deepEqual(row.home.map((opener) => opener.source.label.label), ['Écran h1', 'Écran h2']);
});

test('la place dans une liste de plusieurs choix, et ceux qui l’ouvrent', () => {
  const [row] = describeStageMemberships(buildIndex(), stagePath('b'));
  assert.equal(row.actionPath, actionPath('menu'));
  assert.equal(row.rank, 1);
  assert.equal(row.count, 2);
  assert.deepEqual(row.ok.map((opener) => opener.source.label.label), ['Départ']);
  assert.equal(row.home.length, 0);
});

test('un Écran qu’aucune liste ne propose n’a aucune liste', () => {
  assert.deepEqual(describeStageMemberships(buildIndex(), stagePath('h1')), []);
});

function mount(uuid = 'depart', onGesture = () => {}) {
  const index = buildIndex();
  const entry = index.byPath.get(stagePath(uuid));
  const noop = () => {};
  return mountSurface(React.createElement(StageEditor, {
    inspected: {
      kind: 'stage',
      path: entry.path,
      identifier: uuid,
      label: entry.label,
      node: entry.node,
    },
    project: null,
    index,
    usage: new Map(),
    disabled: false,
    onGesture,
    onDelete: noop,
    onRemoveOption: noop,
    onFocusPath: noop,
    onViewConnections: noop,
  }));
}

function render(uuid = 'depart') {
  return mount(uuid).html;
}

test('le panneau d’Écran : ses deux sorties, puis les listes par lesquelles on arrive', () => {
  const html = render();
  assert.doesNotMatch(html, /Parcours</);
  assert.doesNotMatch(html, /Arrivent ici|Reviennent ici|Ajouter une arrivée|Ajouter un retour HOME/);
  assert.doesNotMatch(html, /Touches de cet Écran|Boutons et lecture|Ne mène nulle part/);
  assert.match(html, /Suite du parcours <em class="advanced-editor__term">okTransition<\/em>/);
  assert.match(html, /Bouton Accueil <em class="advanced-editor__term">homeTransition<\/em>/);
  assert.match(
    html,
    /Suite du parcours.*Quand on appuie sur OK.*À la fin du son.*Mène à.*connection-icon--action.*>Menu<.*2 choix.*aria-label="La liste garde l’ordre[^"]*">\?<\/button><label[^>]*>commence sur<\/label><\/span><select[^>]*>.*<option value="1" selected="">2\/2 · Écran b<\/option>/s,
    'les déclencheurs, puis la liste ouverte et le choix sur lequel on y commence',
  );
  const suite = html.slice(html.indexOf('Suite du parcours'), html.indexOf('Bouton Accueil <em'));
  assert.match(suite, /<option value="0">1\/2 · Écran a<\/option>.*<option value="random">Au hasard, à chaque fois<\/option>/s,
    'le point de départ se choisit sur place, parmi tous les choix de la liste et le hasard');
  assert.match(suite, /aria-label="Changer de liste"/);
  assert.doesNotMatch(suite, />Modifier</, '« Modifier » laissait croire qu’il changeait le choix de départ');
  assert.match(html, /Comment on arrive sur cet Écran/);
  assert.match(html, /<div class="card-title">Molette<\/div>.*Où mène la molette/s);
  assert.match(html, /Bouton Pause/);
  assert.match(html, /C’est l’Écran d’entrée : le pack commence ici\./);
  assert.match(html, /Choix 1\/1 de<\/span>.*>Retour</s, 'une liste à un seul choix se lit 1/1');
  assert.match(
    html,
    /À l’ouverture<\/span>.*>Écran a<.*par sa suite du parcours.*>Écran h1<.*par son bouton Accueil.*>Écran h2</s,
  );
  assert.doesNotMatch(html, /À la molette<\/span>/, 'une liste d’un choix n’a pas de voisin : pas de ligne molette');
  assert.match(html, /Retirer de la liste/);
  assert.doesNotMatch(html, /Ajouter à une liste/, 'l’Écran d’entrée n’est jamais le choix d’une liste');
  assert.match(render('b'), /Ajouter à une liste/);
  assert.match(html, /Sur l’Écran d’entrée, le bouton Accueil reste désactivé/,
    'la racine ne propose pas d’allumer Accueil');
  assert.match(html, /advanced-editor__kind--stage/);
  assert.ok(html.indexOf('Suite du parcours') < html.indexOf('Bouton Accueil <em'));
  assert.ok(html.indexOf('Bouton Accueil <em') < html.indexOf('>Molette</div>'));
  assert.ok(html.indexOf('>Molette</div>') < html.indexOf('Comment on arrive sur cet Écran'));
  assert.doesNotMatch(html, /Utiliser comme Écran racine|Simuler depuis cet Écran/,
    'l’écoute passe par le clic droit, et la racine ne se déplace pas depuis le panneau');
});

test('Accueil sans destination dit le retour par défaut à l’Écran d’entrée', () => {
  const html = render('b');
  assert.match(html, /Bouton Accueil.*Ramène à.*>Départ<.*retour par défaut de la Lunii/s);
  assert.match(html, /Choisir une autre destination/);
});

test('une liste à un seul choix se lit « Mène à » l’Écran, la liste en second', () => {
  const html = render('a');
  assert.match(html, /Mène à<\/div>.*>Départ<.*via la liste.*>Retour<.*un seul choix/s);
});

test('une liste amène sur un choix à son ouverture, ou à la molette d’un voisin', () => {
  // b est le choix 2/2 de Menu : Départ l'ouvre en commençant sur b.
  const b = describeStageMemberships(buildIndex(), stagePath('b'))[0];
  assert.deepEqual(b.direct.map((opener) => opener.source.label.label), ['Départ']);
  assert.deepEqual(b.neighbours.map((neighbour) => [neighbour.side, neighbour.label]), [['both', 'Écran a']]);
  // a est le choix 1/2 : personne n'y commence, et la molette de b n'est pas définie.
  const a = describeStageMemberships(buildIndex(), stagePath('a'))[0];
  assert.deepEqual(a.direct, []);
  const html = render('a');
  assert.doesNotMatch(html, /À l’ouverture<\/span>|À la molette<\/span>/, 'seuls les chemins qui existent sont montrés');
  assert.match(html, /Rien ne mène ici par cette liste/);
});

test('la molette dit quels Écrans elle fait défiler', () => {
  const html = render('b');
  assert.match(html, /Fait défiler.*>Menu<.*aria-label="des deux côtés".*>Écran a<.*choix 1/s);
});

test('le point de départ dans la liste se change sur place, par un seul geste', () => {
  const gestures = [];
  const { elements } = mount('depart', (gesture) => gestures.push(gesture));
  const select = elements.find((element) => element.type === 'select' && element.props.id === 'advanced-landing-ok');
  select.props.onChange({ target: { value: '0' } });
  select.props.onChange({ target: { value: 'random' } });
  assert.deepEqual(gestures, [
    advancedGestures.setStageTransition('depart', 'ok', advancedGestures.transitionTo('menu', 0)),
    advancedGestures.setStageTransition('depart', 'ok', advancedGestures.transitionTo('menu', RANDOM_OPTION_INDEX)),
  ]);
});

test('la suppression est absente de l’Écran racine et présente sur les autres Écrans', () => {
  const root = render('depart');
  assert.doesNotMatch(root, /card--danger/);
  assert.doesNotMatch(root, /Supprimer cet Écran/);
  const other = render('b');
  assert.match(other, /card--danger/);
  assert.doesNotMatch(other, /card-danger-trash"[^>]*disabled/);
  assert.match(other, /Supprimer cet Écran/);
});

test('retirer une destination OK ou Accueil ne change que la transition choisie', () => {
  const index = buildIndex();
  for (const [uuid, slot, label] of [
    ['depart', 'ok', 'Supprimer la transition OK'],
    ['a', 'ok', 'Supprimer la transition OK'],
    ['a', 'home', 'Supprimer la transition Accueil'],
  ]) {
    const inspected = index.byPath.get(stagePath(uuid));
    const rows = describeStageDestinations(index, inspected.path);
    if (slot === 'home') rows[1] = { ...rows[0], slot: 'home' };
    for (const disabled of [false, true]) {
      const gestures = [];
      const { elements } = mountSurface(React.createElement(StageDestinations, {
        stage: { ...inspected.node, path: inspected.path }, rows, index, disabled, thumbnails: new Map(),
        onGesture: (gesture) => gestures.push(gesture), onFocusPath: () => {},
      }));
      const remove = elements.find((element) => element.type === 'button' && element.props['aria-label'] === label);
      assert.ok(remove, 'le retrait est accessible directement');
      assert.equal(remove.props.disabled, disabled);
      remove.props.onClick();
      assert.deepEqual(gestures, disabled ? [] : [
        advancedGestures.setStageTransition(uuid, slot, { form: 'null' }),
      ]);
    }
  }
});
