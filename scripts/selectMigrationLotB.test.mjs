import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import { graphSurfaceHarness } from './i18nGraphSurfaceHarness.mjs';
import { editingHarness, openedEditingSources } from './i18nGraphEditingHarness.mjs';
import { originalGraphLiteralFixtures } from './i18nGraphSourceFixture.mjs';
import { GRAPH_NATIVE_LISTS } from './selectMigrationGraphLists.mjs';
import { installMountedDom, click } from './treeMountedDom.mjs';
import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import { presence, sampleView, stage } from './advancedViewFixtures.mjs';

// Lot select B : listes natives de l'éditeur graphe avancé remplacées par le composant Select. Les libellés des
// options (ordre compris) sont comparés, liste ouverte, à ceux de la source d'origine consignés dans
// selectMigrationGraphLists.mjs (lus dans les fixtures de BASE) ; le type des valeurs transmises en aval est vérifié.

function mountedDom() {
  const dom = installMountedDom();
  dom.document.getElementById = id => dom.document.body.querySelectorAll('*').find(n => n.attributes.id === id) ?? null;
  return dom;
}
const settle = async () => { for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const texts = nodes => nodes.map(n => n.textContent.replace(/\s+/g, ' ').trim());
const key = (node, name) => node.dispatchEvent({ type: 'keydown', key: name, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.cancelBubble = true; } });

async function mountElement(dom, engine, element) {
  const host = dom.document.createElement('div'); dom.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(I18nextProvider, { i18n: engine }, element)));
  await settle();
  return { host, unmount: () => act(async () => root.unmount()) };
}

// Chaque liste du scénario, ouverte puis refermée, dans l'ordre d'apparition.
async function openLists(dom, host) {
  assert.equal(host.querySelectorAll('select').length, 0, 'plus aucune liste native');
  const lists = [];
  for (const trigger of host.querySelectorAll('.select-trigger')) {
    await act(async () => click(trigger)); await settle();
    lists.push(texts(dom.document.body.querySelectorAll('.select-option')));
    await act(async () => click(trigger)); await settle();
  }
  return lists;
}

async function assertScenarioLists(variant, harness, scenarios) {
  const dom = mountedDom();
  try {
    for (const [name, expected] of Object.entries(GRAPH_NATIVE_LISTS[variant])) {
      const [Component, props] = scenarios[name];
      const view = await mountElement(dom, harness.engine, React.createElement(Component, props));
      const actual = await openLists(dom, view.host);
      // L'option désactivée de la source d'origine (« choix illisible ») est devenue le `placeholder` de Select : affichée
      // fermée, absente de la liste ouverte.
      const wanted = expected.map(({ options, placeholder }) => (placeholder ? options.slice(1) : options));
      try { assert.deepEqual(actual, wanted, `${variant}:${name}`); } finally { await view.unmount(); }
    }
  } finally { dom.restore(); }
}

test('éditeur graphe : options des listes identiques à la source BASE, dans l’ordre (états fermés)', async () => {
  const h = await editingHarness();
  try { await assertScenarioLists('editing', h, h.cases); } finally { await h.close(); }
});

// Monté pour de vrai, un effet referme les formulaires que le banc SSR ouvre par l'état initial : on retire ces
// remises à zéro (en mémoire seulement) pour garder l'état ouvert.
function mountableOpenedSources() {
  const sources = openedEditingSources();
  const drop = (file, pattern) => {
    const path = `src/components/AdvancedWorkspace/${file}.jsx`;
    assert.match(sources[path], pattern, `${file} : remise à zéro attendue`);
    sources[path] = sources[path].replace(pattern, '');
  };
  drop('StageDestinations', /setEditing\(null\);\n(?=\s*\}, \[stage\.path\]\);)/);
  drop('StageArrivals', /setAdding\(false\);\n(?=\s*\}, \[stage\.path\]\);)/);
  return sources;
}

test('éditeur graphe : options des listes identiques à la source BASE, dans l’ordre (états ouverts)', async () => {
  const h = await editingHarness(mountableOpenedSources());
  try { await assertScenarioLists('opened', h, h.cases); } finally { await h.close(); }
});

test('constructions dérivées : options identiques à la source BASE, dans l’ordre', async () => {
  const h = await graphSurfaceHarness();
  try { await assertScenarioLists('surface', h, h.scenarios); } finally { await h.close(); }
});

test('construction dérivée : le choix de la déclenche garde ses valeurs texte', async () => {
  const h = await graphSurfaceHarness();
  const dom = mountedDom();
  try {
    const [Construction, props] = h.scenarios.construction;
    const view = await mountElement(dom, h.engine, React.createElement(Construction, props));
    const kind = view.host.querySelector('#construction-kind');
    await act(async () => click(kind)); await settle();
    const options = dom.document.body.querySelectorAll('.select-option');
    assert.deepEqual(texts(options), ['Scène', 'Choix', 'Séquence', 'Tirage au sort']);
    await act(async () => click(options[1])); await settle();
    assert.equal(view.host.querySelector('#construction-kind').textContent.trim(), 'Choix', 'le type choisi est affiché');
    // Le déclencheur n'existe qu'une fois un Écran de départ choisi ; ses trois libellés viennent de la source BASE
    // (originalGraphLiteralFixtures, ligne 126 de CreateConstructionDialog.jsx), dans son ordre.
    const triggerLabels = originalGraphLiteralFixtures.filter(fixture => fixture.source.endsWith('CreateConstructionDialog.jsx') && fixture.line === 126 && ['construction.continueThePathWhenAudioEnds.label', 'construction.continueThePathWithTheOKButton.label', 'construction.boutonAccueil.label'].includes(fixture.key));
    assert.equal(triggerLabels.length, 3);
    await act(async () => click(view.host.querySelector('#construction-source'))); await settle();
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[1])); await settle();
    const trigger = view.host.querySelector('#construction-trigger');
    assert.ok(trigger, 'déclencheur proposé une fois l’Écran de départ choisi');
    assert.equal(trigger.textContent.trim(), triggerLabels[0].expectedFrench, 'valeur initiale : lecture automatique');
    await act(async () => click(trigger)); await settle();
    assert.deepEqual(texts(dom.document.body.querySelectorAll('.select-option')), triggerLabels.map(fixture => fixture.expectedFrench));
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[2])); await settle();
    assert.equal(view.host.querySelector('#construction-trigger').textContent.trim(), 'Bouton Accueil');
    assert.match(view.host.textContent, new RegExp(h.engine.t('graph:construction.trigger.homeWarning').slice(0, 20)), 'la valeur texte « home » pilote l’avertissement');
    await view.unmount();
  } finally { dom.restore(); await h.close(); }
});

test('GraphLinkDialog : la position d’insertion reste un nombre en aval', async () => {
  const h = await editingHarness();
  const dom = mountedDom();
  try {
    const [Dialog, props] = h.rawCases.LinkFromList;
    const gestures = [];
    const view = await mountElement(dom, h.engine, React.createElement(Dialog, { ...props, onConfirm: gesture => gestures.push(gesture) }));
    const rank = view.host.querySelector('#graph-linked-rank');
    assert.equal(rank.textContent.trim(), 'À la fin', 'valeur initiale : le nombre d’options, affiché « À la fin »');
    await act(async () => click(rank)); await settle();
    const options = dom.document.body.querySelectorAll('.select-option');
    await act(async () => click(options[2])); await settle();
    const confirm = view.host.querySelectorAll('button').find(b => b.textContent === h.engine.t('graph:link.create.confirm'));
    await act(async () => click(confirm));
    assert.equal(gestures.length, 1);
    assert.strictEqual(gestures[0].linked.index, 1, '« Avant le choix 2 » : index nombre 1, jamais la chaîne "1"');
    await view.unmount();
    const again = await mountElement(dom, h.engine, React.createElement(Dialog, { ...props, onConfirm: gesture => gestures.push(gesture) }));
    await act(async () => click(again.host.querySelectorAll('button').find(b => b.textContent === h.engine.t('graph:link.create.confirm'))));
    assert.strictEqual(gestures[1].linked.index, props.intent.suggestedIndex ?? props.index.byPath.get(props.intent.sourcePath).node.options.length, 'sans choix : l’index initial, nombre');
    await again.unmount();
  } finally { dom.restore(); await h.close(); }
});

test('LandingSelect et sélection fixe : les valeurs transmises restent des chaînes', async () => {
  const h = await editingHarness();
  const dom = mountedDom();
  try {
    const [Landing, landingProps] = h.rawCases.LandingRandom;
    const received = [];
    const landing = await mountElement(dom, h.engine, React.createElement(Landing, { ...landingProps, onChange: value => received.push(value) }));
    await act(async () => click(landing.host.querySelector('.select-trigger'))); await settle();
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[1])); await settle();
    assert.deepEqual(received, ['1'], 'un rang reste une chaîne (landingGesture applique Number)');
    await landing.unmount();
    const [Fields, fieldsProps] = h.rawCases.ActionSelectionFields;
    const fixed = await mountElement(dom, h.engine, React.createElement(Fields, { ...fieldsProps, onChange: value => received.push(value) }));
    await act(async () => click(fixed.host.querySelector('.select-trigger'))); await settle();
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[1])); await settle();
    assert.deepEqual(received, ['1', '1']);
    await fixed.unmount();
  } finally { dom.restore(); await h.close(); }
});

test('ControlRow et complétion : mêmes gestes qu’avec les listes natives', async () => {
  const dom = mountedDom();
  const h = await editingHarness(openedEditingSources());
  try {
    const [Row, rowProps] = h.rawCases.ControlRow;
    const gestures = [];
    const row = await mountElement(dom, h.engine, React.createElement(Row, { ...rowProps, onGesture: gesture => gestures.push(gesture) }));
    assert.equal(row.host.querySelector('.select-trigger').getAttribute('aria-label'), rowProps.label, 'nom accessible conservé');
    await act(async () => click(row.host.querySelector('.select-trigger'))); await settle();
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[0])); await settle();
    assert.equal(gestures.length, 1);
    assert.deepEqual(gestures[0], (await h.load('src/store/projectModel/advancedGestures.js')).advancedGestures.setStageControls(rowProps.stage.uuid, { [rowProps.control]: (await h.load('src/store/projectModel/advancedGestures.js')).presence.value(true) }));
    await row.unmount();
  } finally { dom.restore(); await h.close(); }
});

test('NodePicker : texte ou rien, jamais une chaîne vide', async () => {
  const h = await editingHarness();
  const dom = mountedDom();
  try {
    const [Picker, props] = h.rawCases.PickerDuplicate;
    const received = [];
    const view = await mountElement(dom, h.engine, React.createElement(Picker, { ...props, onChange: value => received.push(value) }));
    await act(async () => click(view.host.querySelector('.select-trigger'))); await settle();
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[0])); await settle();
    assert.deepEqual(received, [null], '« — choisir — » : null, comme avec le natif');
    await act(async () => click(view.host.querySelector('.select-trigger'))); await settle();
    await act(async () => click(dom.document.body.querySelectorAll('.select-option')[1])); await settle();
    assert.equal(typeof received[1], 'string');
    assert.equal(received[1], props.index.entries.find(e => e.label.label === '_AUTHOR_0_').path);
    await view.unmount();
  } finally { dom.restore(); await h.close(); }
});

test('NodePicker à 160 nœuds : liste ouverte, parcours clavier jusqu’au dernier, choix', async () => {
  const dom = mountedDom();
  const h = await graphSurfaceHarness();
  try {
    const { NodePicker } = await h.load('src/components/AdvancedWorkspace/NodePicker.jsx');
    const view = sampleView();
    view.stages = Array.from({ length: 160 }, (_, i) => stage(`n${String(i).padStart(3, '0')}`, { name: presence(`Nœud ${i}`), ...(i === 0 ? { squareOne: presence(true) } : {}) }));
    view.actions = []; view.edges = [];
    const index = buildGraphIndex(view);
    const chosen = [];
    const picker = await mountElement(dom, h.engine, React.createElement(NodePicker, { index, kind: 'stage', value: null, onChange: value => chosen.push(value), id: 'grand', forChoice: true }));
    const trigger = picker.host.querySelector('#grand');
    await act(async () => click(trigger)); await settle();
    const options = dom.document.body.querySelectorAll('.select-option');
    // La recherche borne la liste à 60 résultats (le champ de filtre atteint les autres) ; l'Écran d’entrée n'y figure pas.
    // searchGraph s'arrête à 60 résultats avant le retrait de l'Écran d'entrée : « — choisir — » + 59 nœuds.
    assert.equal(options.length, 60);
    for (let i = 0; i < 80; i += 1) await act(async () => key(trigger, 'ArrowDown'));
    assert.equal(trigger.getAttribute('aria-activedescendant'), options.at(-1).getAttribute('id'), 'le clavier atteint le dernier nœud et s’y arrête');
    await act(async () => key(trigger, 'Enter')); await settle();
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0], index.entries.filter(e => e.kind === 'stage').slice(0, 60).filter(e => e.node.squareOne?.value !== true).at(-1).path, 'le dernier nœud de la liste est celui choisi');
    assert.equal(dom.document.body.querySelectorAll('.select-option').length, 0, 'liste refermée après le choix');
    // Début de liste, puis « Fin » : même dernier nœud.
    await act(async () => click(trigger)); await settle();
    await act(async () => key(trigger, 'End')); await settle();
    assert.equal(trigger.getAttribute('aria-activedescendant'), dom.document.body.querySelectorAll('.select-option').at(-1).getAttribute('id'));
    await act(async () => key(trigger, 'Escape'));
    await picker.unmount();
  } finally { dom.restore(); await h.close(); }
});
