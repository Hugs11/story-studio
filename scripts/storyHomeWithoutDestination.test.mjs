// Accueil actif sans destination pendant la lecture (`returnOnHomeNone` avec
// le bouton Accueil actif) : le moteur n'écrit aucune transition, et la Lunii
// revient d'elle-même à l'Écran d'entrée (le « Retour Lunii » du graphe). Le
// miroir, la pastille de l'arbre et le panneau « Pendant l'histoire » doivent
// dire ce retour, pas le dossier parent ni la fin de l'histoire.
//
// Le pack fait foi : `native_pack/tests/document_builder.rs`
// (`active_home_without_destination_writes_no_home_transition`) fixe la
// transition nulle écrite par le moteur.

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { getGeneratedStoryNavigation } from '../src/store/generatedNavigation.js';
import { computeBadgesData, formatBadgeTitle } from '../src/components/tree/treeNavigationBadges.js';

const { mountSurface } = await import('./chromeBench.mjs');
const { DuringPlaySection } = await import('../src/components/editors/story/DuringPlaySection.jsx');
const { NavigationTargetSelect } = await import('../src/components/editors/story/storyUtils.jsx');

function story(id, fields = {}) {
  return {
    id,
    type: 'story',
    name: `Histoire ${id.toUpperCase()}`,
    audio: `${id}.mp3`,
    itemAudio: `${id}-titre.mp3`,
    controlSettings: {},
    ...fields,
  };
}

function nestedProject() {
  const a = story('a', { returnOnHomeNone: true, controlSettings: { home: true } });
  const menu = { id: 'menu-m', type: 'menu', name: 'Dossier M', children: [a] };
  const project = { projectType: 'pack', rootEntries: [menu], globalOptions: {} };
  return { a, menu, project };
}

function projectIndexOf(entries) {
  return { entryById: new Map(entries.map((entry) => [entry.id, entry])), parentMenuById: new Map() };
}

test('miroir : Accueil actif sans destination revient à l’Écran d’entrée, pas au dossier', () => {
  const { a, menu, project } = nestedProject();
  const nav = getGeneratedStoryNavigation(a, menu, project, project.rootEntries);

  assert.equal(nav.storyHome.isImplicit, true);
  assert.equal(nav.storyHome.isPackStart, true);
  assert.equal(nav.storyHome.effectiveTargetId, null);
});

test('miroir : même règle pour une histoire à la racine', () => {
  const a = story('a', { returnOnHomeNone: true, controlSettings: { home: true } });
  const project = { projectType: 'pack', rootEntries: [a], globalOptions: {} };
  const nav = getGeneratedStoryNavigation(a, null, project, project.rootEntries);

  assert.equal(nav.storyHome.isPackStart, true);
  assert.equal(nav.storyHome.effectiveTargetId, null);
});

test('miroir (témoin) : une destination Accueil choisie reste cette destination', () => {
  const a = story('a', { returnOnHome: 'root', controlSettings: { home: true } });
  const menu = { id: 'menu-m', type: 'menu', name: 'Dossier M', children: [a] };
  const project = { projectType: 'pack', rootEntries: [menu], globalOptions: {} };
  const nav = getGeneratedStoryNavigation(a, menu, project, project.rootEntries);

  assert.equal(nav.storyHome.isPackStart, false);
  assert.equal(nav.storyHome.effectiveTargetId, 'root');
});

test('pastille : l’arbre annonce le retour à la couverture, pas « Dossier M »', () => {
  const { a, menu, project } = nestedProject();
  const badges = computeBadgesData(a, menu, new Map(), project, project.rootEntries);
  const home = badges.find((badge) => badge.kind === 'home-implicit');

  assert.ok(home, JSON.stringify(badges));
  assert.equal(home.targetId, null);
  const ui = formatBadgeTitle(home, projectIndexOf([menu, a]));
  assert.doesNotMatch(ui.title, /Dossier M/);
  assert.match(ui.title, /couverture/);
});

test('panneau : la destination Accueil affichée est le retour à la couverture', () => {
  const { a, menu, project } = nestedProject();
  const { html, elements } = mountSurface(React.createElement(DuringPlaySection, {
    node: a,
    project,
    allMenus: [menu],
    allStories: [a],
    parentMenu: menu,
    onUpdate: () => {},
  }));
  const select = elements.find((element) => element.type === NavigationTargetSelect);

  assert.ok(select, 'sélecteur de destination Accueil');
  assert.equal(select.props.value, '__none__');
  assert.equal(select.props.includeNone, true);
  assert.match(html, /Retour à la couverture du pack/);
  assert.doesNotMatch(html, /Dossier M/);
});

test('panneau : choisir le retour à la couverture garde Accueil sans destination', () => {
  const { a, menu, project } = nestedProject();
  const updates = [];
  const { elements } = mountSurface(React.createElement(DuringPlaySection, {
    node: { ...a, returnOnHomeNone: false, returnOnHome: 'story:b' },
    project,
    allMenus: [menu],
    allStories: [a],
    parentMenu: menu,
    onUpdate: (patch) => updates.push(patch),
  }));
  const select = elements.find((element) => element.type === NavigationTargetSelect);
  select.props.onChange('__none__');

  assert.deepEqual(updates, [{ returnOnHome: null, returnOnHomeNone: true }]);
});
