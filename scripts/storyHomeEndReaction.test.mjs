// Réaction Accueil de fin active (au moins deux étapes, sans enchaînement) :
// pendant la lecture, le bouton Accueil mène à cette réaction, quelle que soit
// la destination Accueil réglée sur l'histoire. Le miroir, la pastille de
// l'arbre et le panneau « Pendant l'histoire » doivent le dire.
//
// Le pack fait foi : `native_pack/tests/after_playback_next_story.rs`
// (`active_home_step_replaces_the_story_home_destination`) fixe la transition
// Accueil écrite par le moteur sur l'Écran de lecture (`story_branch.rs`,
// `sequence_transitions.home`).

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { getGeneratedStoryNavigation, isEndHomeStepActive } from '../src/store/generatedNavigation.js';
import { computeBadgesData, formatBadgeTitle } from '../src/components/tree/treeNavigationBadges.js';

const { mountSurface } = await import('./chromeBench.mjs');
const { DuringPlaySection } = await import('../src/components/editors/story/DuringPlaySection.jsx');
const { EndSequenceEditor } = await import('../src/components/editors/story/EndSequenceEditor.jsx');
const { ErrorDialogProvider } = await import('../src/components/common/Dialog.jsx');
const { NavigationTargetSelect } = await import('../src/components/editors/story/storyUtils.jsx');

const step = (id, fields = {}) => ({
  id,
  name: `Étape ${id}`,
  audio: `${id}.mp3`,
  controlSettings: { autoplay: true, ok: false, home: true, pause: false, wheel: false },
  ...fields,
});

function story(id, fields = {}) {
  return {
    id,
    type: 'story',
    name: `Histoire ${id.toUpperCase()}`,
    audio: `${id}.mp3`,
    itemAudio: `${id}-titre.mp3`,
    controlSettings: { home: true },
    ...fields,
  };
}

function withReaction(fields = {}, steps = [step('s1'), step('s2', { okTarget: 'root' })]) {
  return story('a', {
    afterPlaybackSequence: steps,
    afterPlaybackHomeStep: step('reaction', { name: 'Réaction A', homeTarget: 'root' }),
    ...fields,
  });
}

function projectWith(a, globalOptions = {}) {
  const b = story('b');
  const menu = { id: 'menu-m', type: 'menu', name: 'Dossier M', children: [a, b] };
  return { menu, project: { projectType: 'pack', rootEntries: [menu], globalOptions } };
}

function projectIndexOf(entries) {
  return { entryById: new Map(entries.map((entry) => [entry.id, entry])), parentMenuById: new Map() };
}

test('N-03 : Accueil désactivé rend la réaction inactive dans le miroir', () => {
  const a = withReaction({ controlSettings: { home: false } });
  const { menu, project } = projectWith(a);
  assert.equal(isEndHomeStepActive(a, project), false);
  const nav = getGeneratedStoryNavigation(a, menu, project, project.rootEntries);
  assert.equal(nav.storyHome.isInactive, true);
  assert.equal(nav.storyHome.isEndHomeStep, false);
});

for (const home of [false, true]) {
  test(`N-03 : l’éditeur de fin avertit seulement si Accueil est désactivé (home=${home})`, () => {
    const a = withReaction({ controlSettings: { home } });
    const { html } = mountSurface(React.createElement(ErrorDialogProvider, null, React.createElement(EndSequenceEditor, {
      node: a, steps: a.afterPlaybackSequence, homeStep: a.afterPlaybackHomeStep,
      allMenus: [], allStories: [a], onUpdate: () => {},
    })));
    assert.equal(html.includes('Accueil est désactivé : cette réaction ne sera pas jouée.'), !home);
  });
}

for (const [label, fields] of [
  ['par défaut', {}],
  ['destination choisie', { returnOnHome: 'story:b' }],
  ['sans destination', { returnOnHomeNone: true }],
]) {
  test(`miroir (${label}) : Accueil pendant la lecture mène à la réaction Accueil de fin`, () => {
    const a = withReaction(fields);
    const { menu, project } = projectWith(a);
    const nav = getGeneratedStoryNavigation(a, menu, project, project.rootEntries);

    assert.equal(nav.storyHome.effectiveTargetId, 'story_home_step:a');
    assert.equal(nav.storyHome.isEndHomeStep, true);
    assert.equal(nav.storyHome.isPackStart, false);
  });
}

test('miroir (témoin) : une seule étape, la réaction n’est pas écrite, la destination choisie reste', () => {
  const a = withReaction({ returnOnHome: 'story:b' }, [step('s1', { okTarget: 'root' })]);
  const { menu, project } = projectWith(a);
  const nav = getGeneratedStoryNavigation(a, menu, project, project.rootEntries);

  assert.equal(nav.storyHome.effectiveTargetId, 'story:b');
  assert.equal(nav.storyHome.isEndHomeStep, false);
});

test('miroir (témoin) : avec l’enchaînement, la réaction n’est pas écrite', () => {
  const a = withReaction({ returnOnHome: 'story:b' });
  const { menu, project } = projectWith(a, { autoNext: true });
  const nav = getGeneratedStoryNavigation(a, menu, project, project.rootEntries);

  assert.equal(nav.storyHome.effectiveTargetId, 'story:b');
  assert.equal(nav.storyHome.isEndHomeStep, false);
});

test('pastille : l’arbre annonce la réaction Accueil, pas la destination réglée', () => {
  const a = withReaction({ returnOnHome: 'story:b' });
  const { menu, project } = projectWith(a);
  const badges = computeBadgesData(a, menu, new Map(), project, project.rootEntries);
  const homeBadges = badges.filter((badge) => badge.kind.startsWith('home'));

  assert.equal(homeBadges.length, 1, JSON.stringify(badges));
  assert.equal(homeBadges[0].targetId, 'story_home_step:a');
  const ui = formatBadgeTitle(homeBadges[0], projectIndexOf([menu, a, ...menu.children]));
  assert.match(ui.title, /réaction Accueil/i);
  assert.doesNotMatch(ui.title, /Histoire B/);
});

test('panneau : la destination Accueil affichée est la réaction, sans sélecteur trompeur', () => {
  const a = withReaction({ returnOnHome: 'story:b' });
  const { menu, project } = projectWith(a);
  const { html, elements } = mountSurface(React.createElement(DuringPlaySection, {
    node: a,
    project,
    allMenus: [menu],
    allStories: menu.children,
    parentMenu: menu,
    onUpdate: () => {},
  }));

  assert.equal(elements.filter((element) => element.type === NavigationTargetSelect).length, 0);
  assert.match(html, /Réaction au bouton Accueil/);
  assert.doesNotMatch(html, /Histoire B/);
});
