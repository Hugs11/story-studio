// Validation des fins d'histoire et des médias selon les réglages actifs.
//
// Un champ que le réglage courant rend inutile (fin locale sous Auto-next,
// image d'un dossier « Écran transparent », message de fin global qu'aucune
// histoire n'emprunte) n'est ni exigé ni vérifié : le constructeur Rust ne le
// lit pas. À l'inverse, un média réellement lu par le constructeur est vérifié
// avant génération, et une destination du message de fin global qui ne mène
// plus nulle part reste « à corriger ».

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeProjectData, removeEntryCascadingRefs } from '../src/store/projectModel.js';
import { getGenerateErrors, getProjectValidationIssues } from '../src/store/projectValidation.js';

const FILES = [
  'D:/p/root.mp3', 'D:/p/root.png', 'D:/p/thumb.png',
  'D:/p/a.mp3', 'D:/p/a-title.mp3', 'D:/p/a-title.png',
  'D:/p/b.mp3', 'D:/p/b-title.mp3', 'D:/p/b-title.png',
  'D:/p/menu.mp3', 'D:/p/end.mp3', 'D:/p/end.png',
];

// La normalisation du projet peut réécrire les séparateurs d'un chemin absolu :
// l'audit connaît les deux graphies.
function audit(missing = []) {
  const result = {};
  const mark = (path, present) => {
    result[path] = present;
    result[path.replaceAll('/', '\\')] = present;
  };
  for (const path of FILES) mark(path, true);
  for (const path of missing) mark(path, false);
  return result;
}

function story(id, overrides = {}) {
  return {
    id,
    type: 'story',
    name: `Histoire ${id}`,
    audio: `D:/p/${id}.mp3`,
    itemAudio: `D:/p/${id}-title.mp3`,
    itemImage: `D:/p/${id}-title.png`,
    ...overrides,
  };
}

function project(overrides = {}) {
  return normalizeProjectData({
    projectName: 'Pack',
    packMetadata: { title: 'Pack', version: 1, minAge: '3' },
    projectType: 'pack',
    globalOptions: {},
    rootAudio: 'D:/p/root.mp3',
    rootImage: 'D:/p/root.png',
    thumbnailImage: 'D:/p/thumb.png',
    rootEntries: [story('a'), story('b')],
    ...overrides,
  });
}

function step(id, overrides = {}) {
  return {
    id,
    name: `Étape ${id}`,
    audio: 'D:/p/end.mp3',
    controlSettings: { ok: true, home: true, autoplay: false },
    ...overrides,
  };
}

// --- Message de fin global qu'aucune histoire n'emprunte ---

test('un audio global que toutes les fins locales remplacent n\'est plus vérifié', () => {
  const p = project({
    globalOptions: { nightMode: true },
    nightModeAudio: 'D:/p/global-perdu.mp3',
    rootEntries: [
      story('a', { afterPlaybackPromptAudio: 'D:/p/end.mp3' }),
      story('b', { afterPlaybackSequence: [step('s1')] }),
    ],
  });
  assert.deepEqual(getGenerateErrors(p, audit(['D:/p/global-perdu.mp3'])), []);
});

test('témoin : l\'audio global emprunté par une histoire reste vérifié', () => {
  const p = project({
    globalOptions: { nightMode: true },
    nightModeAudio: 'D:/p/global-perdu.mp3',
    rootEntries: [story('a', { afterPlaybackPromptAudio: 'D:/p/end.mp3' }), story('b')],
  });
  const issues = getProjectValidationIssues(p, audit(['D:/p/global-perdu.mp3']));
  assert.ok(issues.some((issue) => issue.id === 'end-node'), JSON.stringify(issues));
});

// --- Médias de fin inactifs sous Auto-next ---

test('sous Auto-next, les médias de fin locale ne sont plus vérifiés', () => {
  const p = project({
    globalOptions: { autoNext: true },
    rootEntries: [
      story('a', { afterPlaybackPromptAudio: 'D:/p/prompt-perdu.mp3' }),
      story('b', { afterPlaybackSequence: [step('s1', { audio: 'D:/p/fin-perdue.mp3' }), step('s2', { audio: null })] }),
    ],
  });
  assert.deepEqual(getGenerateErrors(p, audit(['D:/p/prompt-perdu.mp3', 'D:/p/fin-perdue.mp3'])), []);
});

test('témoin : sans Auto-next, un prompt perdu reste signalé', () => {
  const p = project({
    rootEntries: [story('a', { afterPlaybackPromptAudio: 'D:/p/prompt-perdu.mp3' }), story('b')],
  });
  assert.ok(getGenerateErrors(p, audit(['D:/p/prompt-perdu.mp3'])).length > 0);
});

// --- Écran transparent ---

test('l\'image d\'un dossier « Écran transparent » n\'est plus vérifiée', () => {
  const p = project({
    rootEntries: [{
      id: 'menu',
      type: 'menu',
      name: 'Dossier',
      audio: 'D:/p/menu.mp3',
      image: 'D:/p/menu-perdu.png',
      autoBlackImage: true,
      children: [story('a'), story('b')],
    }],
  });
  assert.deepEqual(getGenerateErrors(p, audit(['D:/p/menu-perdu.png'])), []);
});

test('témoin : sans Écran transparent, l\'image perdue reste signalée', () => {
  const p = project({
    rootEntries: [{
      id: 'menu',
      type: 'menu',
      name: 'Dossier',
      audio: 'D:/p/menu.mp3',
      image: 'D:/p/menu-perdu.png',
      children: [story('a'), story('b')],
    }],
  });
  assert.ok(getGenerateErrors(p, audit(['D:/p/menu-perdu.png'])).length > 0);
});

// --- Destination du message de fin global supprimée ---

for (const field of ['nightModeReturn', 'nightModeHomeReturn']) {
  test(`supprimer l'histoire visée par ${field} rend le message de fin « à corriger »`, () => {
    const before = project({
      globalOptions: { nightMode: true },
      nightModeAudio: 'D:/p/end.mp3',
      [field]: 'story:b',
      rootEntries: [story('a'), story('b'), story('c', { audio: 'D:/p/a.mp3' })],
    });
    assert.deepEqual(getGenerateErrors(before, audit()), [], 'témoin : la destination existe');

    const after = removeEntryCascadingRefs(before, 'b');
    assert.equal(after[field], 'story:b', 'la destination supprimée reste visible, pas vidée en silence');
    const issues = getProjectValidationIssues(after, audit());
    const issue = issues.find((candidate) => candidate.id === 'end-node');
    assert.ok(issue, `le message de fin doit être à corriger : ${JSON.stringify(issues)}`);
    assert.match(issue.text, /introuvable/);
  });
}

test('témoin : une destination globale vide reste le retour par défaut, valide', () => {
  const p = project({
    globalOptions: { nightMode: true },
    nightModeAudio: 'D:/p/end.mp3',
    nightModeReturn: null,
    nightModeHomeReturn: null,
  });
  assert.deepEqual(getGenerateErrors(p, audit()), []);
});

// --- Étape de fin sans audio ---

test('une étape de fin sans audio n\'empêche pas la génération', () => {
  const p = project({
    rootEntries: [story('a', { afterPlaybackSequence: [step('s1', { audio: null })] }), story('b')],
  });
  assert.deepEqual(getGenerateErrors(p, audit()), []);
});

// --- Médias de la réaction Accueil et images d'étapes ---

function homeStepProject(homeStep, sequence = [step('s1'), step('s2')]) {
  return project({
    rootEntries: [
      story('a', { afterPlaybackSequence: sequence, afterPlaybackHomeStep: homeStep }),
      story('b'),
    ],
  });
}

test('l\'audio perdu de la réaction Accueil est signalé', () => {
  const p = homeStepProject(step('home', { audio: 'D:/p/home-perdu.mp3' }));
  assert.ok(getGenerateErrors(p, audit(['D:/p/home-perdu.mp3'])).length > 0);
});

test('N-03 : les médias perdus d’une réaction avec Accueil désactivé sont ignorés', () => {
  const p = homeStepProject(step('home', { audio: 'D:/p/home-perdu.mp3', image: 'D:/p/home-perdu.png' }));
  p.rootEntries[0].controlSettings = { home: false };
  assert.deepEqual(getGenerateErrors(p, audit(['D:/p/home-perdu.mp3', 'D:/p/home-perdu.png'])), []);
});

test('l\'image perdue de la réaction Accueil est signalée', () => {
  const p = homeStepProject(step('home', { image: 'D:/p/home-perdu.png' }));
  assert.ok(getGenerateErrors(p, audit(['D:/p/home-perdu.png'])).length > 0);
});

test('l\'image perdue d\'une étape de fin est signalée', () => {
  const p = homeStepProject(null, [step('s1', { image: 'D:/p/step-perdu.png' }), step('s2')]);
  assert.ok(getGenerateErrors(p, audit(['D:/p/step-perdu.png'])).length > 0);
});

test('témoin : une réaction Accueil sans média reste valide', () => {
  const p = homeStepProject(step('home', { audio: null, image: null }));
  assert.deepEqual(getGenerateErrors(p, audit()), []);
});

test('une réaction Accueil que le constructeur n\'écrit pas (séquence d\'une étape) n\'est pas vérifiée', () => {
  const p = homeStepProject(step('home', { audio: 'D:/p/home-perdu.mp3' }), [step('s1')]);
  assert.deepEqual(getGenerateErrors(p, audit(['D:/p/home-perdu.mp3'])), []);
});

// --- Destinations de la réaction Accueil et choix OK des étapes de fin ---
//
// Miroir de `validation.rs` : la réaction Accueil active (séquence d'au moins
// deux étapes, Accueil actif, pas d'Auto-next) fait vérifier sa destination OK,
// ses choix OK et sa destination Accueil (sauf « suit OK » ou « aucune ») ;
// chaque étape d'une séquence active fait vérifier ses choix OK.

function deletedTargetProject(storyA) {
  const before = project({ rootEntries: [story('a', storyA), story('b'), story('c')] });
  assert.deepEqual(getGenerateErrors(before, audit()), [], 'témoin : la destination existe');
  return removeEntryCascadingRefs(before, 'c');
}

function errorsOfA(p) {
  return getProjectValidationIssues(p, audit())
    .filter((issue) => issue.id === 'a' && issue.status === 'error')
    .map((issue) => issue.text);
}

const deletedHomeStepTargets = {
  'la destination OK': { okTarget: 'story:c' },
  'un choix OK': { okChoiceTargets: ['story:b', 'story:c'] },
  'la destination Accueil': { homeTarget: 'story:c' },
};

for (const [label, fields] of Object.entries(deletedHomeStepTargets)) {
  test(`${label} de la réaction Accueil vers une histoire supprimée est « à corriger »`, () => {
    const after = deletedTargetProject({
      afterPlaybackSequence: [step('s1'), step('s2')],
      afterPlaybackHomeStep: step('home', fields),
    });
    const errors = errorsOfA(after);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /réaction Accueil/);
    assert.match(errors[0], /introuvable/);
  });
}

test('un choix OK d’une étape de fin vers une histoire supprimée est « à corriger »', () => {
  const after = deletedTargetProject({
    afterPlaybackSequence: [step('s1', { okChoiceTargets: ['story:c'] }), step('s2')],
  });
  const errors = errorsOfA(after);
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /OK fin 1/);
  assert.match(errors[0], /introuvable/);
});

const inactiveHomeStepTargets = {
  'Accueil désactivé': {
    controlSettings: { home: false },
    afterPlaybackSequence: [step('s1'), step('s2')],
    afterPlaybackHomeStep: step('home', { okTarget: 'story:c', homeTarget: 'story:c', okChoiceTargets: ['story:c'] }),
  },
  'séquence d’une étape': {
    afterPlaybackSequence: [step('s1')],
    afterPlaybackHomeStep: step('home', { okTarget: 'story:c', homeTarget: 'story:c', okChoiceTargets: ['story:c'] }),
  },
  'Accueil qui suit OK': {
    afterPlaybackSequence: [step('s1'), step('s2')],
    afterPlaybackHomeStep: step('home', { homeTarget: 'story:c', homeFollowsOk: true }),
  },
  'Accueil sans destination': {
    afterPlaybackSequence: [step('s1'), step('s2')],
    afterPlaybackHomeStep: step('home', { homeTarget: 'story:c', homeNone: true }),
  },
};

for (const [label, storyA] of Object.entries(inactiveHomeStepTargets)) {
  test(`témoin : ${label}, une destination inactive de la réaction Accueil n’est pas vérifiée`, () => {
    assert.deepEqual(getGenerateErrors(deletedTargetProject(storyA), audit()), []);
  });
}

test('témoin : sous Auto-next, les choix OK d’une étape de fin ne sont pas vérifiés', () => {
  const before = project({
    globalOptions: { autoNext: true },
    rootEntries: [story('a', { afterPlaybackSequence: [step('s1', { okChoiceTargets: ['story:c'] })] }), story('b'), story('c')],
  });
  assert.deepEqual(getGenerateErrors(removeEntryCascadingRefs(before, 'c'), audit()), []);
});

// --- Une cible « Retour de fin – X » suit l'activité de la réaction de X ---
//
// Le constructeur ne construit la réaction Accueil de X que si elle est active
// (`end_home_step_is_active`) : un Lien ou une destination de fin vers une
// réaction non construite est « à corriger », comme une histoire supprimée.

function homeStepTargetProject({ xHome = true, xSteps = 2, autoNext = false, via }) {
  const x = story('a', {
    controlSettings: { home: xHome },
    afterPlaybackSequence: Array.from({ length: xSteps }, (_, index) => step(`s${index + 1}`)),
    afterPlaybackHomeStep: step('home'),
  });
  const rootEntries = via === 'lien'
    ? [x, story('b'), { id: 'lien', type: 'ref', target: 'story_home_step:a' }]
    : [x, story('b', { afterPlaybackSequence: [step('b1', { okTarget: 'story_home_step:a' })] })];
  return project({ globalOptions: { autoNext }, rootEntries });
}

const unbuiltHomeReactions = {
  'Accueil de X désactivé, par un Lien': { xHome: false, via: 'lien' },
  'séquence d’une étape, par un Lien': { xSteps: 1, via: 'lien' },
  'Enchaîner les histoires actif, par un Lien': { autoNext: true, via: 'lien' },
  'Accueil de X désactivé, par une destination de fin': { xHome: false, via: 'fin' },
  'séquence d’une étape, par une destination de fin': { xSteps: 1, via: 'fin' },
};

for (const [label, options] of Object.entries(unbuiltHomeReactions)) {
  test(`« Retour de fin – X » vers une réaction non construite (${label}) est « à corriger »`, () => {
    const errors = getProjectValidationIssues(homeStepTargetProject(options), audit())
      .filter((issue) => issue.status === 'error')
      .map((issue) => issue.text);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /Retour de fin introuvable/);
  });
}

for (const via of ['lien', 'fin']) {
  test(`témoin : « Retour de fin – X » vers une réaction construite reste valide (${via})`, () => {
    assert.deepEqual(getGenerateErrors(homeStepTargetProject({ via }), audit()), []);
  });
}
