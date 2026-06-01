import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectData } from '../src/store/projectModel.js';
import { getProjectValidationIssues } from '../src/store/projectValidation.js';

function buildProject(overrides = {}) {
  return normalizeProjectData({
    projectName: 'Pack de test',
    packMetadata: { title: 'Pack de test', version: 1, minAge: '3' },
    projectType: 'pack',
    globalOptions: {},
    rootAudio: 'D:/projet/root.mp3',
    rootImage: 'D:/projet/root.png',
    thumbnailImage: 'D:/projet/thumb.png',
    rootEntries: [
      {
        id: 'story-1',
        type: 'story',
        name: 'Histoire 1',
        audio: 'D:/projet/story1.mp3',
        itemAudio: 'D:/projet/story1-title.mp3',
        itemImage: 'D:/projet/story1-title.png',
      },
    ],
    ...overrides,
  });
}

function find(issues, predicate) {
  return issues.find(predicate) ?? null;
}

test('warns and short-circuits when no projectType is set', () => {
  const project = normalizeProjectData({
    projectName: '',
    packMetadata: {},
    projectType: null,
    globalOptions: {},
    rootEntries: [],
  });

  const issues = getProjectValidationIssues(project);
  const warning = find(issues, (i) => i.id === 'root' && i.status === 'warning');
  assert.ok(warning, `un warning root est attendu, reçu: ${JSON.stringify(issues)}`);
  assert.match(warning.text, /Aucun type de projet/i);
  // L'absence de projectType court-circuite : on n'obtient pas d'autres issues structurelles.
  assert.equal(issues.length, 1);
});

test('reports an error listing duplicated entry IDs and how many share them', () => {
  const project = buildProject({
    rootEntries: [
      { id: 'shared', type: 'story', name: 'A', audio: 'a.mp3' },
      { id: 'shared', type: 'story', name: 'B', audio: 'b.mp3' },
      { id: 'shared', type: 'story', name: 'C', audio: 'c.mp3' },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const dup = find(issues, (i) => i.status === 'error' && /duplique/i.test(i.text));
  assert.ok(dup, 'erreur de duplication attendue');
  assert.match(dup.text, /shared/);
  assert.match(dup.text, /3/); // count = 3
});

test('reports an error when an entry uses the reserved id "root"', () => {
  const project = buildProject({
    rootEntries: [
      { id: 'root', type: 'story', name: 'Mauvais id', audio: 'a.mp3' },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const reservedAtRoot = find(issues, (i) => i.id === 'root' && /Identifiant reserve utilise/i.test(i.text));
  assert.ok(reservedAtRoot, `erreur sur l'ID racine réservé attendue, reçu: ${JSON.stringify(issues)}`);
});

test('warns with "Menu racine — audio intro manquant" when rootAudio is missing', () => {
  const project = buildProject({ rootAudio: '' });

  const issues = getProjectValidationIssues(project);
  const missingAudio = find(issues, (i) => i.text === 'Menu racine — audio intro manquant');
  assert.ok(missingAudio, `warning audio intro attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(missingAudio.status, 'warning');
});

test('pack project missing thumbnailImage hints at the « même image » checkbox', () => {
  const project = buildProject({ thumbnailImage: '' });

  const issues = getProjectValidationIssues(project);
  const thumb = find(issues, (i) => /image bibliothèque manquante/.test(i.text));
  assert.ok(thumb, 'warning image bibliothèque attendu');
  assert.match(thumb.text, /cocher « même image » ou en choisir une/);
  assert.equal(thumb.status, 'warning');
});

test('warns "histoire manquante" when a story has no audio', () => {
  const project = buildProject({
    rootEntries: [
      { id: 'story-x', type: 'story', name: 'Histoire X', audio: '' },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const missing = find(issues, (i) => i.id === 'story-x' && /histoire manquante/.test(i.text));
  assert.ok(missing, `warning « histoire manquante » attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(missing.status, 'warning');
});

test('warns "collection vide" for a menu with no playable descendant', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'menu-empty',
        type: 'menu',
        name: 'Menu vide',
        audio: 'menu.mp3',
        image: 'menu.png',
        children: [],
      },
      { id: 'story-1', type: 'story', name: 'Histoire', audio: 's.mp3', itemAudio: 't.mp3', itemImage: 'i.png' },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const empty = find(issues, (i) => i.id === 'menu-empty' && /collection vide/.test(i.text));
  assert.ok(empty, `warning emptyMenu attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(empty.status, 'warning');
});

test('warns "Le pack ne contient aucune histoire." when a pack project has no playable entry', () => {
  const project = buildProject({ rootEntries: [] });

  const issues = getProjectValidationIssues(project);
  const empty = find(issues, (i) => i.text === 'Le pack ne contient aucune histoire.');
  assert.ok(empty, `warning emptyPack attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(empty.status, 'warning');
});

test('reports a missingTarget error when returnAfterPlay points to a nonexistent menu', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'story-broken',
        type: 'story',
        name: 'Histoire cassée',
        audio: 's.mp3',
        itemAudio: 't.mp3',
        itemImage: 'i.png',
        returnAfterPlay: 'menu:nope-does-not-exist',
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const broken = find(issues, (i) => i.id === 'story-broken' && i.status === 'error' && /destination de retour introuvable/.test(i.text));
  assert.ok(broken, `erreur missingTarget attendue, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
});

test('reports an emptyTarget error when returnAfterPlay points to a menu with no playable descendant', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'menu-empty',
        type: 'menu',
        name: 'Menu vide',
        audio: 'menu.mp3',
        image: 'menu.png',
        children: [],
      },
      {
        id: 'story-points-to-empty',
        type: 'story',
        name: 'Histoire qui revient vers vide',
        audio: 's.mp3',
        itemAudio: 't.mp3',
        itemImage: 'i.png',
        returnAfterPlay: 'menu:menu-empty',
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const empty = find(issues, (i) => i.id === 'story-points-to-empty' && i.status === 'error' && /destination de retour vide/.test(i.text));
  assert.ok(empty, `erreur emptyTarget attendue, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
});

test('a story with controlSettings.autoplay = true still requires selection image and audio', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'story-autoplay',
        type: 'story',
        name: 'Autoplay',
        audio: 's.mp3',
        itemAudio: '',
        itemImage: '',
        controlSettings: { autoplay: true },
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const aboutStory = issues.filter((i) => i.id === 'story-autoplay');
  assert.ok(
    aboutStory.some((issue) => /image manquante/.test(issue.text)),
    `warning image attendu pour une histoire autoplay, reçu: ${JSON.stringify(aboutStory)}`,
  );
  assert.ok(
    aboutStory.some((issue) => /audio titre manquant/.test(issue.text)),
    `warning audio titre attendu pour une histoire autoplay, reçu: ${JSON.stringify(aboutStory)}`,
  );
});

test('a story with controlSettings.autoplay = true still requires selection audio when image is present', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'story-autoplay-audio',
        type: 'story',
        name: 'Autoplay audio',
        audio: 's.mp3',
        itemAudio: '',
        itemImage: 'i.png',
        controlSettings: { autoplay: true },
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const aboutStory = issues.filter((i) => i.id === 'story-autoplay-audio');
  assert.ok(
    aboutStory.some((issue) => /audio titre manquant/.test(issue.text)),
    `warning audio titre attendu pour une histoire autoplay avec image, reçu: ${JSON.stringify(aboutStory)}`,
  );
  assert.equal(
    aboutStory.some((issue) => /image manquante/.test(issue.text)),
    false,
    `aucun warning image attendu quand l'image est presente, reçu: ${JSON.stringify(aboutStory)}`,
  );
});
