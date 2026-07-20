import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeBadgesData,
  formatBadgeTitle,
  getStrongestStatus,
} from '../src/components/tree/treeNavigationBadges.js';

// --- getStrongestStatus ---

test('getStrongestStatus renvoie error si une issue error existe', () => {
  assert.equal(
    getStrongestStatus([{ status: 'warning' }, { status: 'error' }]),
    'error',
  );
});

test('getStrongestStatus renvoie warn pour warn ou warning', () => {
  assert.equal(getStrongestStatus([{ status: 'warning' }]), 'warn');
  assert.equal(getStrongestStatus([{ status: 'warn' }]), 'warn');
});

test('getStrongestStatus renvoie null sur liste vide', () => {
  assert.equal(getStrongestStatus([]), null);
  assert.equal(getStrongestStatus(), null);
});

// --- computeBadgesData : cas qui ne touchent pas a getGeneratedStoryNavigation ---

test('computeBadgesData : menu avec nativeGraph preserveForRoundTrip', () => {
  const entry = { type: 'menu', id: 'm1', nativeGraph: { preserveForRoundTrip: true } };
  const data = computeBadgesData(entry, null, new Map(), {}, []);
  assert.deepEqual(data, [{ kind: 'graph' }]);
});

test('computeBadgesData : menu avec importedContinuation porte le sourceStoryName', () => {
  const entry = { type: 'menu', id: 'm1', importedContinuation: { sourceStoryName: 'Histoire source' } };
  const data = computeBadgesData(entry, null, new Map(), {}, []);
  assert.deepEqual(data, [{ kind: 'continuation', sourceStoryName: 'Histoire source' }]);
});

test('computeBadgesData : menu avec importedContinuation sans sourceStoryName -> null', () => {
  const entry = { type: 'menu', id: 'm1', importedContinuation: {} };
  const data = computeBadgesData(entry, null, new Map(), {}, []);
  assert.deepEqual(data, [{ kind: 'continuation', sourceStoryName: null }]);
});

test('computeBadgesData : entry non-story et non-menu special -> tableau vide', () => {
  assert.deepEqual(computeBadgesData({ type: 'zip', id: 'z1' }, null, new Map(), {}, []), []);
  assert.deepEqual(computeBadgesData(null, null, new Map(), {}, []), []);
});

test('computeBadgesData : histoire via message de fin configuré expose un badge de fin', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const target = {
    id: 'story-b',
    type: 'story',
    name: 'B',
    audio: 'b.mp3',
    itemAudio: 'b-title.mp3',
    controlSettings: {},
  };
  const project = {
    rootEntries: [entry, target],
    nightModeAudio: 'night.mp3',
    nightModeReturn: 'story:story-b',
    globalOptions: { nightMode: true },
  };

  assert.deepEqual(
    computeBadgesData(entry, null, new Map(), project, project.rootEntries),
    [{
      kind: 'end-night',
      status: null,
      targetId: 'story:story-b',
      isDefault: false,
      isImportedPrompt: false,
    }],
  );
});

test('computeBadgesData : message de fin sans audio expose déjà le parcours configuré', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const project = {
    rootEntries: [entry],
    globalOptions: { endNode: true },
  };

  assert.deepEqual(
    computeBadgesData(entry, null, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [{
      kind: 'end-node',
      status: 'default',
      targetId: 'story:story-a',
      isDefault: true,
      isImportedPrompt: false,
    }, {
      kind: 'home',
      status: 'default',
      targetId: 'story:story-a',
      isInactive: false,
      isDefault: true,
    }],
  );
});

test('computeBadgesData : option default affiche retour et Home par défaut', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const menu = {
    id: 'menu-1',
    type: 'menu',
    name: 'Menu',
    children: [entry],
  };
  const project = { rootEntries: [menu] };

  assert.deepEqual(
    computeBadgesData(entry, menu, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [
      { kind: 'return', status: 'default', targetId: 'menu-1', isDefault: true },
      { kind: 'home', status: 'default', targetId: 'menu-1', isInactive: false, isDefault: true },
    ],
  );
});

test('computeBadgesData : Home actif sans transition explicite devient natif implicite', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    returnOnHomeNone: true,
    controlSettings: { home: true },
  };
  const project = { rootEntries: [entry] };

  assert.deepEqual(
    computeBadgesData(entry, null, new Map(), project, project.rootEntries),
    [{ kind: 'home-implicit', status: null, targetId: 'story:story-a', isDefault: false }],
  );
});

test('computeBadgesData : Home par défaut suit le retour pour une histoire racine', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const project = { rootEntries: [entry] };

  assert.deepEqual(
    computeBadgesData(entry, null, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [
      { kind: 'return', status: 'default', targetId: 'story:story-a', isDefault: true },
      { kind: 'home', status: 'default', targetId: 'story:story-a', isInactive: false, isDefault: true },
    ],
  );
});

test('computeBadgesData : Home par défaut reste sur le menu quand auto-next avance', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const nextStory = {
    id: 'story-b',
    type: 'story',
    name: 'B',
    audio: 'b.mp3',
    itemAudio: 'b-title.mp3',
    controlSettings: {},
  };
  const menu = {
    id: 'menu-1',
    type: 'menu',
    name: 'Menu',
    children: [entry, nextStory],
  };
  const project = { rootEntries: [menu], globalOptions: { autoNext: true } };

  assert.deepEqual(
    computeBadgesData(entry, menu, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [
      { kind: 'return', status: 'default', targetId: 'story_play:story-b', isDefault: true },
      { kind: 'home', status: 'default', targetId: 'menu-1', isInactive: false, isDefault: true },
    ],
  );
});

test('computeBadgesData : Home par défaut reste sur le menu quand returnAfterPlay est explicite', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    returnAfterPlay: 'root',
    controlSettings: {},
  };
  const menu = {
    id: 'menu-1',
    type: 'menu',
    name: 'Menu',
    children: [entry],
  };
  const project = { rootEntries: [menu] };

  assert.deepEqual(
    computeBadgesData(entry, menu, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [
      { kind: 'return', status: null, targetId: 'root', isDefault: false },
      { kind: 'home', status: 'default', targetId: 'menu-1', isInactive: false, isDefault: true },
    ],
  );
});

test('computeBadgesData : option default désactivée garde les retours par défaut masqués', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const menu = {
    id: 'menu-1',
    type: 'menu',
    name: 'Menu',
    children: [entry],
  };
  const project = { rootEntries: [menu] };

  assert.deepEqual(
    computeBadgesData(entry, menu, new Map(), project, project.rootEntries, { showDefaultReturns: false }),
    [],
  );
});

test('computeBadgesData : message de fin expose fin et Home pendant histoire par défaut', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    afterPlaybackPromptAudio: 'end.mp3',
    afterPlaybackPromptControlSettings: {},
  };
  const menu = {
    id: 'menu-1',
    type: 'menu',
    name: 'Menu',
    children: [entry],
  };
  const project = { rootEntries: [menu] };

  assert.deepEqual(
    computeBadgesData(entry, menu, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [
      { kind: 'prompt-return', status: 'default', targetId: 'menu-1', isDefault: true, isInactive: false },
      { kind: 'home', status: 'default', targetId: 'menu-1', isInactive: false, isDefault: true },
    ],
  );
});

test('computeBadgesData : message de fin sans cible explicite expose la destination effective par défaut', () => {
  const entry = {
    id: 'story-a',
    type: 'story',
    name: 'A',
    audio: 'a.mp3',
    itemAudio: 'a-title.mp3',
    controlSettings: {},
  };
  const menu = {
    id: 'menu-1',
    type: 'menu',
    name: 'Menu',
    children: [entry],
  };
  const project = {
    rootEntries: [menu],
    nightModeAudio: 'night.mp3',
    globalOptions: { nightMode: true },
  };

  assert.deepEqual(
    computeBadgesData(entry, menu, new Map(), project, project.rootEntries, { showDefaultReturns: true }),
    [
      {
        kind: 'end-night',
        status: 'default',
        targetId: 'menu-1',
        isDefault: true,
        isImportedPrompt: false,
      },
      { kind: 'home', status: 'default', targetId: 'menu-1', isInactive: false, isDefault: true },
    ],
  );
});

// --- formatBadgeTitle : transforme DATA en UI ---

test('formatBadgeTitle : graph -> badge fixe sans nom resolu', () => {
  const ui = formatBadgeTitle({ kind: 'graph' }, /* projectIndex */ null);
  assert.equal(ui.key, 'native-graph');
  assert.equal(ui.label, '◇');
  assert.match(ui.title, /Graphe interactif/);
});

test('formatBadgeTitle : continuation utilise sourceStoryName fourni', () => {
  const ui = formatBadgeTitle({ kind: 'continuation', sourceStoryName: 'Source A' }, null);
  assert.match(ui.title, /Source A/);
});

test('formatBadgeTitle : continuation sans sourceStoryName -> "une histoire"', () => {
  const ui = formatBadgeTitle({ kind: 'continuation', sourceStoryName: null }, null);
  assert.match(ui.title, /depuis une histoire/);
});

test('formatBadgeTitle : home-none, title fixe, status passe', () => {
  const ui = formatBadgeTitle({ kind: 'home-none', status: 'warn' }, null);
  assert.equal(ui.kind, 'home-none');
  assert.equal(ui.status, 'warn');
  assert.match(ui.title, /désactivé/);
});

test('formatBadgeTitle : home-implicit décrit la destination effective', () => {
  const ui = formatBadgeTitle({ kind: 'home-implicit', status: null, targetId: 'menu-1' }, makeProjectIndexStub([
    { id: 'menu-1', name: 'Menu', type: 'menu' },
  ]));
  assert.equal(ui.kind, 'home-implicit');
  assert.match(ui.title, /Menu/);
});

// Mini stub d'un projectIndex compatible avec getGeneratedNavigationTargetName.
// Le module reel resout via entryById.get + nom de l'entry. Notre stub fait
// pareil.
function makeProjectIndexStub(entries) {
  const map = new Map(entries.map((e) => [e.id, e]));
  return {
    entryById: map,
    parentMenuById: new Map(),
    flatEntries: entries.map((e) => ({ id: e.id, entry: e })),
    entryIdCounts: new Map(),
    menuEntries: [],
    rootPlayableCount: 0,
    firstSimpleStory: null,
  };
}

test('formatBadgeTitle : return -> resout le nom de la cible via projectIndex', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'story-target', type: 'story', name: 'Cible Retour' },
  ]);
  const ui = formatBadgeTitle({ kind: 'return', status: null, targetId: 'story-target' }, projectIndex);
  assert.match(ui.title, /Cible Retour/);
  assert.equal(ui.label, '↩');
});

test('formatBadgeTitle : return décrit le comportement sans wording par défaut/modifié', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'menu-target', type: 'menu', name: 'Menu parent' },
  ]);
  const ui = formatBadgeTitle({ kind: 'return', status: 'default', targetId: 'menu-target', isDefault: true }, projectIndex);
  assert.match(ui.title, /À la fin de l'histoire → « Menu parent »/);
  assert.doesNotMatch(ui.title, /par défaut|modifié/i);
  assert.match(ui.title, /Menu parent/);
});

test('formatBadgeTitle : prompt-return décrit le trajet via le message de fin', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'menu-target', type: 'menu', name: 'Menu parent' },
  ]);
  const ui = formatBadgeTitle({
    kind: 'prompt-return',
    status: 'default',
    targetId: 'menu-target',
    isDefault: true,
    isInactive: false,
  }, projectIndex);
  assert.match(ui.title, /À la fin de l'histoire : passage par le message de fin personnalisé → « Menu parent »/);
  assert.doesNotMatch(ui.title, /par défaut|modifié/i);
});

test('formatBadgeTitle : home (configure, isInactive false) -> décrit le bouton Accueil', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'story-home', type: 'story', name: 'Maison' },
  ]);
  const ui = formatBadgeTitle({ kind: 'home', status: null, targetId: 'story-home', isInactive: false }, projectIndex);
  assert.match(ui.title, /Appuie sur le bouton Accueil pendant la lecture → « Maison »/);
  assert.doesNotMatch(ui.title, /par défaut|modifié/i);
});

test('formatBadgeTitle : home default décrit le comportement sans wording par défaut/modifié', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'menu-home', type: 'menu', name: 'Menu parent' },
  ]);
  const ui = formatBadgeTitle({ kind: 'home', status: 'default', targetId: 'menu-home', isInactive: false, isDefault: true }, projectIndex);
  assert.match(ui.title, /Appuie sur le bouton Accueil pendant la lecture → « Menu parent »/);
  assert.doesNotMatch(ui.title, /par défaut|modifié/i);
  assert.match(ui.title, /Menu parent/);
});

test('formatBadgeTitle : home isInactive -> titre warning enrichi', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'story-home', type: 'story', name: 'Maison' },
  ]);
  const ui = formatBadgeTitle({ kind: 'home', status: 'warn', targetId: 'story-home', isInactive: true }, projectIndex);
  assert.match(ui.title, /Maison/);
  assert.match(ui.title, /desactive|désactivé/);
});

test('formatBadgeTitle : end-night -> resout la destination finale', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'story-target', type: 'story', name: 'Après la nuit' },
  ]);
  const ui = formatBadgeTitle({ kind: 'end-night', targetId: 'story:story-target' }, projectIndex);
  assert.equal(ui.kind, 'end-night');
  assert.match(ui.title, /message de fin/);
  assert.match(ui.title, /Après la nuit/);
});

test('formatBadgeTitle : end-night default décrit le passage par le message de fin', () => {
  const projectIndex = makeProjectIndexStub([
    { id: 'story-target', type: 'story', name: 'Après la nuit' },
  ]);
  const ui = formatBadgeTitle({ kind: 'end-night', status: 'default', targetId: 'story:story-target', isDefault: true }, projectIndex);
  assert.match(ui.title, /À la fin de l'histoire : passage par le message de fin/);
  assert.doesNotMatch(ui.title, /par défaut|modifié/i);
  assert.match(ui.title, /message de fin/);
});

test('formatBadgeTitle : data kind inconnu -> null', () => {
  assert.equal(formatBadgeTitle({ kind: 'unknown' }, null), null);
});

// --- Invariant central de la refonte : le NOM de la cible n'est pas dans DATA ---

test('Invariant : computeBadgesData ne stocke aucun nom textuel', () => {
  // Pour qu'un cache par-entry-reference soit correct, computeBadgesData
  // ne doit pas embarquer de texte resolu. On verifie sur tous les kinds
  // que les seuls champs sont structurels.
  const allowedFieldsByKind = {
    graph: new Set(['kind']),
    continuation: new Set(['kind', 'sourceStoryName']), // legitime : vient de l'entry directement
    return: new Set(['kind', 'status', 'targetId', 'isDefault', 'flow']),
    'prompt-return': new Set(['kind', 'status', 'targetId', 'isDefault', 'isInactive']),
    'home-none': new Set(['kind', 'status', 'isDefault']),
    'home-implicit': new Set(['kind', 'status', 'targetId', 'isDefault']),
    home: new Set(['kind', 'status', 'targetId', 'isInactive', 'isDefault']),
    'end-node': new Set(['kind', 'status', 'targetId', 'isDefault', 'isImportedPrompt']),
    'end-night': new Set(['kind', 'status', 'targetId', 'isDefault', 'isImportedPrompt']),
  };
  const samples = [
    { kind: 'graph' },
    { kind: 'continuation', sourceStoryName: 'X' },
    { kind: 'return', status: null, targetId: 'X', isDefault: false, flow: 'sequence' },
    { kind: 'prompt-return', status: null, targetId: 'X', isDefault: false, isInactive: false },
    { kind: 'home-none', status: null, isDefault: false },
    { kind: 'home-implicit', status: null, targetId: 'menu-1', isDefault: false },
    { kind: 'home', status: null, targetId: 'X', isInactive: false, isDefault: false },
    { kind: 'end-node', status: null, targetId: 'X', isDefault: false, isImportedPrompt: false },
    { kind: 'end-night', status: null, targetId: 'X', isDefault: false, isImportedPrompt: false },
  ];
  for (const sample of samples) {
    const allowed = allowedFieldsByKind[sample.kind];
    for (const key of Object.keys(sample)) {
      assert.ok(allowed.has(key), `Champ inattendu "${key}" sur kind "${sample.kind}" -- les noms textuels doivent rester dans formatBadgeTitle`);
    }
  }
});
