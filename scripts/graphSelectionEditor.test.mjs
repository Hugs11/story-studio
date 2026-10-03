// L'Inspecteur d'une sélection de plusieurs nœuds du graphe : ce qui se fait
// d'un coup sur tous, comme la sélection multiple du Libre.

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

const { mountSurface, elementByAttribute } = await import('./chromeBench.mjs');
const { GraphSelectionEditor, sharedControlState } = await import('../src/components/AdvancedWorkspace/GraphSelectionEditor.jsx');
const { ErrorDialogProvider } = await import('../src/components/common/Dialog.jsx');
const { ProjectContext } = await import('../src/store/ProjectContext.js');
const { ACTION_KIND, STAGE_KIND } = await import('../src/store/advancedGraphView/graphViewModel.js');

const stage = (uuid, name, color = null) => ({
  kind: STAGE_KIND,
  path: `/stageNodes/@uuid=${uuid}#0`,
  node: { uuid, personalColor: color },
  label: name ? { label: name, isFallback: false } : { label: uuid, isFallback: true },
});
const action = (id, color = null) => ({
  kind: ACTION_KIND,
  path: `/actionNodes/@id=${id}#0`,
  node: { id, personalColor: color },
  label: { label: 'Action node', isFallback: true },
});

function render(entries, overrides = {}) {
  const calls = { color: [], remove: [] };
  const mounted = mountSurface(React.createElement(
    ErrorDialogProvider,
    null,
    React.createElement(GraphSelectionEditor, {
      entries,
      onSetColor: (paths, color) => calls.color.push([paths, color]),
      onAssignMedia: async () => {},
      onDelete: (paths) => calls.remove.push(paths),
      ...overrides,
    }),
  ));
  return { ...mounted, calls };
}

test('le panneau résume la sélection et ne génère que pour les Écrans nommés', () => {
  const { html } = render([stage('s1', 'La forêt'), stage('s2', null), action('a1')]);
  assert.match(html, /3 nœuds sélectionnés : 2 Écrans, 1 liste de choix\./);
  assert.match(html, /pour 1 Écran nommé/);
  assert.match(html, /1 Écran sans nom est ignoré/);
  assert.match(html, /Images-titres/);
});

test('sans Écran nommé, rien à générer ; sans Écran, pas de génération du tout', () => {
  const untitled = render([stage('s1', null), stage('s2', null)]).html;
  assert.match(untitled, /Aucun Écran sélectionné ne porte de nom/);
  const actionsOnly = render([action('a1'), action('a2')]).html;
  assert.doesNotMatch(actionsOnly, /Génération groupée/);
  assert.match(actionsOnly, /2 listes de choix/);
});

test('la couleur et le retrait portent sur toute la sélection', () => {
  const entries = [stage('s1', 'Un', '#ff0000'), action('a1', '#00ff00')];
  const { elements, calls, html } = render(entries);
  assert.match(html, /différente sur 2 nœuds/);
  elementByAttribute(elements, 'aria-label', 'Retirer la couleur').props.onClick();
  assert.deepEqual(calls.color, [[entries.map((entry) => entry.path), null]]);
  elementByAttribute(elements, 'aria-label', 'Retirer la sélection').props.onClick();
  assert.deepEqual(calls.remove, [entries.map((entry) => entry.path)]);
});

test('les audios titres prononcent le nom de chaque Écran, et reviennent sur lui', async () => {
  const queued = [];
  const assigned = [];
  const entries = [stage('s1', '  La forêt  '), stage('s2', null), stage('s3', 'Le château')];
  const { elements } = mountSurface(React.createElement(
    ProjectContext.Provider,
    {
      value: {
        xttsSettings: { backend: 'piper', piperVoice: 'fr_FR-test', language: 'fr' },
        onQueueXttsGenerate: async (job) => { queued.push(job); },
        savePath: '/tmp/projet.mbah',
      },
    },
    React.createElement(ErrorDialogProvider, null, React.createElement(GraphSelectionEditor, {
      entries,
      projectEpoch: 7,
      onSetColor: () => {},
      onAssignMedia: async (...args) => { assigned.push(args); },
      onDelete: () => {},
    })),
  ));
  const button = elements.find((element) => element.props?.className === 'batch-generate-btn'
    && [].concat(element.props.children).includes('Audios titres'));
  await button.props.onClick();
  // Le nom d'auteur, sans ses espaces de bord ; l'Écran sans nom est ignoré.
  assert.deepEqual(queued.map((job) => job.request.text), ['La forêt', 'Le château']);
  assert.deepEqual(queued.map((job) => job.request.voice), ['fr_FR-test', 'fr_FR-test']);
  assert.equal(queued[0].target.kind, 'advancedStage');
  assert.equal(queued[0].target.projectEpoch, 7);
  await queued[1].target.apply('/tmp/chateau.wav');
  assert.deepEqual(assigned, [['s3', 'audio', '/tmp/chateau.wav']]);
});

const set = (value) => ({ presence: 'value', value });
const controlled = (uuid, name, members) => {
  const entry = stage(uuid, name);
  entry.node.controls = {
    presence: 'value',
    wheel: set(true), ok: set(true), home: set(true), pause: set(false), autoplay: set(false),
    ...members,
  };
  return entry;
};

test('un bouton est allumé, éteint ou mixte selon les Écrans', () => {
  const a = controlled('s1', 'Un', { pause: set(true) });
  const b = controlled('s2', 'Deux', {});
  const c = controlled('s3', 'Trois', { pause: { presence: 'null' } });
  assert.equal(sharedControlState([a, b], 'ok'), 'on');
  assert.equal(sharedControlState([a, b], 'autoplay'), 'off');
  assert.equal(sharedControlState([a, b], 'pause'), 'mixed');
  // Un membre indéfini ne se confond pas avec « éteint ».
  assert.equal(sharedControlState([b, c], 'pause'), 'mixed');
});

test('les boutons se règlent sur les Écrans qui en ont, les autres sont nommés', () => {
  const calls = [];
  const bare = stage('s3', 'Sans boutons');
  const entries = [controlled('s1', 'Un', { pause: set(true) }), controlled('s2', 'Deux', {}), bare, action('a1')];
  const { elements, html } = render(entries, {
    onSetControls: (...args) => calls.push(args),
  });
  assert.match(html, /Réglés d’un coup sur 2 Écrans\./);
  assert.match(html, /Suite du parcours<em class="advanced-editor__term">okTransition<\/em>.*Quand on appuie sur OK.*À la fin du son.*Bouton Accueil<em class="advanced-editor__term">homeTransition<\/em>/s);
  assert.match(html, /1 Écran n’a pas encore de boutons/);
  const pause = elementByAttribute(elements, 'ariaLabel', 'Bouton Pause — sur la sélection');
  assert.equal(pause.props.mixed, true);
  // Mixte, un clic allume le bouton partout.
  pause.props.onChange(true);
  assert.deepEqual(calls, [[['s1', 's2'], 'pause', true]]);
});
