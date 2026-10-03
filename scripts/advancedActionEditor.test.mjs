// Le panneau d'une Liste de choix (une Action) : ses choix, puis qui l'ouvre.

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import { action, presence, stage } from './advancedViewFixtures.mjs';

const { mountSurface } = await import('./chromeBench.mjs');
const { ActionEditor } = await import('../src/components/AdvancedWorkspace/ActionEditor.jsx');

const stagePath = (uuid) => `/stageNodes/@uuid=${uuid}#0`;
const actionPath = (id) => `/actionNodes/@id=${id}#0`;

function transition(kind, from, index) {
  return {
    edgeId: `${stagePath(from)}::${kind}`,
    kind: `stage-${kind}`,
    from: stagePath(from),
    to: actionPath('menu'),
    optionId: null,
    ordinal: 0,
    selection: { kind: 'fixed', index },
    dangling: false,
  };
}

function render({
  choices = ['a', 'b'],
  edges = [
    transition('ok', 'depart', 0),
    transition('home', 'h1', 1),
    transition('home', 'h2', 1),
    transition('home', 'h3', 0),
  ],
} = {}) {
  const stages = ['depart', 'a', 'b', 'h1', 'h2', 'h3'];
  const index = buildGraphIndex({
    viewVersion: 1,
    entry: { status: 'unique', stagePath: stagePath('depart'), candidates: [stagePath('depart')] },
    counts: { stages: stages.length, actions: 1, options: choices.length, edges: edges.length },
    stages: stages.map((uuid) => stage(uuid, { name: presence(`Écran ${uuid}`) })),
    actions: [action('menu', choices, { name: presence('Menu') })],
    edges,
    mediaRefs: [],
    groups: [],
    opaqueMembers: [],
    diagnostics: [],
  });
  const inspected = {
    kind: 'action',
    path: actionPath('menu'),
    identifier: 'menu',
    label: { label: 'Menu', isFallback: false },
    node: index.byPath.get(actionPath('menu')).node,
  };
  const noop = () => {};
  return mountSurface(React.createElement(ActionEditor, {
    inspected,
    project: null,
    index,
    disabled: false,
    onGesture: noop,
    onDelete: noop,
    onRemoveOption: noop,
    onWire: noop,
    onFocusPath: noop,
    onViewConnections: noop,
  })).html;
}

test('les choix ne sont listés qu’une fois, à leur place n/N, avec leurs gestes dans un menu', () => {
  const html = render();
  assert.match(html, /advanced-editor__kind--action">Liste de choix</);
  assert.match(html, /Ordre des choix <span class="advanced-count">2<\/span>/, 'le nombre de choix en pastille');
  assert.match(html, /advanced-options__position">1\/2</);
  assert.match(html, /advanced-options__position">2\/2</);
  const choices = html.slice(0, html.indexOf('Comment on arrive sur cette liste'));
  assert.equal(choices.match(/>Écran b</g)?.length, 1, 'une seule ligne par choix');
  assert.doesNotMatch(html, /Parcours/);
  assert.doesNotMatch(html, /Insérer avant/, 'les gestes de ligne vivent dans le menu « ⋯ »');
  assert.match(html, /aria-label="Gestes du choix 1"/);
  assert.match(html, /aria-label="Déplacer le choix 2"/);
  assert.match(html, /Ajouter un choix/);
  assert.match(html, /Supprimer cette liste de choix/);
});

test('les accès à la liste viennent après son ordre : par OK, par HOME, et un seul raccord', () => {
  const html = render();
  assert.doesNotMatch(html, /Arrivent ici|Reviennent ici|Ajouter une arrivée|Ajouter un retour HOME/);
  assert.match(html, /Ordre des choix <span class="advanced-count">2<\/span>/);
  assert.match(html, /Ordre commun à tous les accès à cette liste/);
  assert.ok(html.indexOf('advanced-count">2<') < html.indexOf('Comment on arrive sur cette liste'));
  assert.match(html, /advanced-options__subhead">Par la suite du parcours de 1 Écran</);
  assert.match(html, /advanced-options__subhead">Par le bouton Accueil de 3 Écrans</);
  assert.doesNotMatch(html, /advanced-options__slot/, 'plus de pastille « Suite » / « Accueil »');
  // Dans l'ordre du graphe : l'Écran d'origine, puis, dessous, le choix sur
  // lequel il ouvre la liste — réglable sur place, comme depuis l'Écran.
  const opens = (origin, position, target) => new RegExp(
    `>${origin}</button></span></div><div class="advanced-exit__landing">`
    + `.*?commence sur</label></span><select[^>]*>.*?<option value="[0-9]+" selected="">${position} · ${target}</option>`,
    's',
  );
  assert.match(html, opens('Écran depart', '1/2', 'Écran a'), 'par OK, chaque Écran dit sur quel choix il ouvre la liste');
  assert.match(html, opens('Écran h3', '1/2', 'Écran a'), 'par HOME, un Écran seul sur son choix n’est pas groupé');
  assert.doesNotMatch(html, /→ \d/, 'plus de flèche d’un Écran à l’autre qui saute la liste');
  assert.match(html, /aria-expanded="false"/, 'groupes repliés par défaut');
  assert.match(
    html,
    /advanced-count">2 Écrans<\/span><span class="advanced-options__verb">commencent sur<\/span><span class="advanced-options__rank advanced-options__position">2\/2<.*?>Écran b</s,
    'deux Écrans sur le même choix : un groupe qui dit combien, et sur quel Écran',
  );
  assert.doesNotMatch(html, /advanced-options__count/, 'plus de nombre seul qui ressemble à un rang');
  assert.equal(html.match(/Relier un Écran/g)?.length, 1);
  assert.doesNotMatch(html, /Utiliser cette Action depuis un Écran/);
});

test('une liste d’un seul choix ne demande pas où commencer', async () => {
  const { LandingSelect } = await import('../src/components/AdvancedWorkspace/LandingSelect.jsx');
  const choices = [{ key: 'o0', rank: 0, label: 'Écran a' }];
  const mount = (landing) => mountSurface(React.createElement(LandingSelect, {
    id: 'essai', landing, choices, disabled: false, onChange: () => {},
  })).html;
  assert.equal(mount({ rank: 0 }), '', 'rien à régler');
  const random = mount({ random: true });
  assert.match(random, /<option value="random" selected="">/, 'un hasard importé reste visible, pour être corrigé');
});

test('une liste d’un seul choix ne répète ni le compte ni le point de départ de ses retours', () => {
  const html = render({
    choices: ['a'],
    edges: [transition('home', 'h1', 0), transition('home', 'h2', 0), transition('home', 'h3', 0)],
  });
  assert.match(html, /advanced-options__subhead">Par le bouton Accueil de 3 Écrans</);
  assert.match(html, /<button type="button" class="advanced-link">Voir les 3 Écrans<\/button>/);
  assert.doesNotMatch(html, /commencent sur/, 'un seul choix : rien à dire du point de départ');
});

test('chaque choix dit qui commence dessus', () => {
  const html = render();
  assert.match(html, />Écran a<\/button><span class="advanced-choice__note">départ de Écran depart et Écran h3</);
  assert.match(html, />Écran b<\/button><span class="advanced-choice__note">départ de Écran h1 et Écran h2</);
});
