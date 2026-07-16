import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectData } from '../src/store/projectModel.js';
import { getProjectValidationIssues } from '../src/store/projectValidation.js';
import {
  createSilentStoryTitleUpdate,
  createStorySelectionAudioUpdate,
  createSilentStoryTitleSettings,
  isExplicitSilentStoryTitle,
  isStorySelectionAudioRequired,
} from '../src/store/storyTitleStage.js';

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
  assert.match(warning.text, /Type de projet à choisir/i);
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
  const dup = find(issues, (i) => i.status === 'error' && /dupliqué/i.test(i.text));
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
  const reservedAtRoot = find(issues, (i) => i.id === 'root' && /Identifiant réservé à corriger/i.test(i.text));
  assert.ok(reservedAtRoot, `erreur sur l'ID racine réservé attendue, reçu: ${JSON.stringify(issues)}`);
});

test('warns with "Menu racine — Audio d’accueil à ajouter" when rootAudio is missing', () => {
  const project = buildProject({ rootAudio: '' });

  const issues = getProjectValidationIssues(project);
  const missingAudio = find(issues, (i) => i.text === "Menu racine — Audio d'accueil à ajouter");
  assert.ok(missingAudio, `warning audio intro attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(missingAudio.status, 'warning');
});

test('pack project missing thumbnailImage hints at the « même image » checkbox', () => {
  const project = buildProject({ thumbnailImage: '' });

  const issues = getProjectValidationIssues(project);
  const thumb = find(issues, (i) => /Image bibliothèque à ajouter/.test(i.text));
  assert.ok(thumb, 'warning image bibliothèque attendu');
  assert.match(thumb.text, /cocher « même image » ou en choisir une/);
  assert.equal(thumb.status, 'warning');
});

test('pack project with sameImage validates only the root image', () => {
  const project = buildProject({ sameImage: true, thumbnailImage: '' });

  const issues = getProjectValidationIssues(project);
  assert.equal(
    find(issues, (i) => /Image bibliothèque/.test(i.text)),
    null,
    `aucun warning vignette attendu avec même image, reçu: ${JSON.stringify(issues.map((i) => i.text))}`,
  );
  assert.equal(project.thumbnailImage, project.rootImage);
});

test('pack project with sameImage and missing root image does not duplicate thumbnail warning', () => {
  const project = buildProject({ sameImage: true, rootImage: '', thumbnailImage: '' });

  const issues = getProjectValidationIssues(project);
  assert.ok(find(issues, (i) => /Image de couverture à ajouter/.test(i.text)));
  assert.equal(
    find(issues, (i) => /Image bibliothèque/.test(i.text)),
    null,
    `aucun warning vignette attendu quand même image dépend de la couverture, reçu: ${JSON.stringify(issues.map((i) => i.text))}`,
  );
});

test('warns "Histoire à ajouter" when a story has no audio', () => {
  const project = buildProject({
    rootEntries: [
      { id: 'story-x', type: 'story', name: 'Histoire X', audio: '' },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const missing = find(issues, (i) => i.id === 'story-x' && /Histoire à ajouter/.test(i.text));
  assert.ok(missing, `warning « Histoire à ajouter » attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(missing.status, 'warning');
});

test('warns "Histoire à ajouter" for a menu with no playable descendant', () => {
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
  const empty = find(issues, (i) => i.id === 'menu-empty' && /Histoire à ajouter/.test(i.text));
  assert.ok(empty, `warning emptyMenu attendu, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
  assert.equal(empty.status, 'warning');
});

test('warns "Histoire à ajouter dans le pack." when a pack project has no playable entry', () => {
  const project = buildProject({ rootEntries: [] });

  const issues = getProjectValidationIssues(project);
  const empty = find(issues, (i) => i.text === 'Histoire à ajouter dans le pack.');
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
  const broken = find(issues, (i) => i.id === 'story-broken' && i.status === 'error' && /destination dossier introuvable/.test(i.text));
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
  const empty = find(issues, (i) => i.id === 'story-points-to-empty' && i.status === 'error' && /destination dossier vide/.test(i.text));
  assert.ok(empty, `erreur emptyTarget attendue, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
});

test('accepts direct story playback as an after-play destination', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'story-source',
        type: 'story',
        name: 'Histoire source',
        audio: 'source.mp3',
        itemAudio: 'source-title.mp3',
        itemImage: 'source.png',
        returnAfterPlay: 'story_play:story-target',
      },
      {
        id: 'story-target',
        type: 'story',
        name: 'Histoire cible',
        audio: 'target.mp3',
        itemAudio: 'target-title.mp3',
        itemImage: 'target.png',
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const brokenTarget = find(issues, (i) => i.id === 'story-source' && /destination de retour/.test(i.text));
  assert.equal(brokenTarget, null, `aucune erreur de destination attendue, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
});

test('reports a missingTarget error when direct story playback points to a nonexistent story', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'story-source',
        type: 'story',
        name: 'Histoire source',
        audio: 'source.mp3',
        itemAudio: 'source-title.mp3',
        itemImage: 'source.png',
        returnAfterPlay: 'story_play:missing-story',
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const broken = find(issues, (i) => i.id === 'story-source' && i.status === 'error' && /destination histoire introuvable/.test(i.text));
  assert.ok(broken, `erreur missingTarget attendue, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
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
    aboutStory.some((issue) => /Image à ajouter/.test(issue.text)),
    `warning image attendu pour une histoire autoplay, reçu: ${JSON.stringify(aboutStory)}`,
  );
  assert.ok(
    aboutStory.some((issue) => /Audio de sélection à ajouter/.test(issue.text)),
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
    aboutStory.some((issue) => /Audio de sélection à ajouter/.test(issue.text)),
    `warning audio titre attendu pour une histoire autoplay avec image, reçu: ${JSON.stringify(aboutStory)}`,
  );
  assert.equal(
    aboutStory.some((issue) => /Image à ajouter/.test(issue.text)),
    false,
    `aucun warning image attendu quand l'image est presente, reçu: ${JSON.stringify(aboutStory)}`,
  );
});

test('a story with an explicit silent title stage does not require selection audio', () => {
  const project = buildProject({
    rootEntries: [
      {
        id: 'story-silent-title',
        type: 'story',
        name: 'Titre silencieux',
        audio: 's.mp3',
        itemAudio: '',
        itemImage: 'i.png',
        silentTitleStage: true,
        titleControlSettings: { wheel: true, ok: true, home: true, pause: false, autoplay: false },
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const aboutStory = issues.filter((i) => i.id === 'story-silent-title');
  assert.equal(isStorySelectionAudioRequired(project.rootEntries[0]), false);
  assert.equal(
    aboutStory.some((issue) => /Audio de sélection à ajouter/.test(issue.text)),
    false,
    `aucun warning audio titre attendu pour un titre explicite silencieux, reçu: ${JSON.stringify(aboutStory)}`,
  );
});

test('story selection audio is required without an explicit title stage', () => {
  assert.equal(isStorySelectionAudioRequired({ itemAudio: null }), true);
  assert.equal(isStorySelectionAudioRequired({
    itemAudio: null,
    titleControlSettings: { wheel: true, ok: true },
  }), true);
  assert.equal(isExplicitSilentStoryTitle({ itemAudio: null }), false);
});

test('the advanced silent-selection toggle and audio updates remain mutually exclusive', () => {
  const titleControlSettings = createSilentStoryTitleSettings({ wheel: false, home: false });
  const silentStory = createSilentStoryTitleUpdate(titleControlSettings);
  const withAudio = { ...silentStory, ...createStorySelectionAudioUpdate('selection.mp3') };
  const clearedAudio = { ...withAudio, ...createStorySelectionAudioUpdate(null) };

  assert.deepEqual(titleControlSettings, {
    autoplay: false,
    ok: true,
    home: false,
    pause: false,
    wheel: false,
  });
  assert.equal(isExplicitSilentStoryTitle(silentStory), true);
  assert.equal(isExplicitSilentStoryTitle(withAudio), false);
  assert.equal(isStorySelectionAudioRequired(withAudio), false);
  assert.equal(withAudio.silentTitleStage, false);
  assert.equal(isExplicitSilentStoryTitle(clearedAudio), false);
  assert.equal(isStorySelectionAudioRequired(clearedAudio), true);
});

function buildProjectWithRef(refOverride) {
  return buildProject({
    rootEntries: [
      {
        id: 'story-1',
        type: 'story',
        name: 'Histoire 1',
        audio: 'D:/projet/story1.mp3',
        itemAudio: 'D:/projet/story1-title.mp3',
        itemImage: 'D:/projet/story1-title.png',
      },
      { id: 'ref-1', type: 'ref', ...refOverride },
    ],
  });
}

test('a ref to an existing story raises no ref issue and is not "unsupported"', () => {
  const issues = getProjectValidationIssues(buildProjectWithRef({ target: 'story:story-1' }));
  const refIssues = issues.filter((i) => i.id === 'ref-1');
  assert.equal(refIssues.length, 0, `aucune issue ref attendue, reçu: ${JSON.stringify(refIssues)}`);
});

test('a ref to a missing target is flagged as an error', () => {
  const issues = getProjectValidationIssues(buildProjectWithRef({ target: 'story:does-not-exist' }));
  const err = find(issues, (i) => i.id === 'ref-1' && i.status === 'error');
  assert.ok(err, `une erreur de cible introuvable est attendue, reçu: ${JSON.stringify(issues)}`);
});

test('a ref without a target is flagged as an error', () => {
  const issues = getProjectValidationIssues(buildProjectWithRef({}));
  const err = find(issues, (i) => i.id === 'ref-1' && i.status === 'error' && /Référence sans cible/.test(i.text));
  assert.ok(err, `une erreur "référence sans cible" est attendue, reçu: ${JSON.stringify(issues)}`);
});

test('a ref to a stale shared story is treated as a missing target', () => {
  const project = buildProject({
    rootEntries: [{ id: 'ref-1', type: 'ref', target: 'story:shared-story' }],
    sharedEntries: [
      {
        id: 'shared-story',
        type: 'story',
        name: 'Scene commune',
        audio: 'shared.mp3',
        itemAudio: 'shared-title.mp3',
        itemImage: 'shared.png',
      },
    ],
  });

  const issues = getProjectValidationIssues(project);
  const missing = find(issues, (i) => i.id === 'ref-1' && /destination histoire introuvable/.test(i.text));
  assert.ok(missing, `erreur cible absente attendue, reçu: ${JSON.stringify(issues.map((i) => i.text))}`);
});
