// La médiathèque commune vue depuis un projet graphe.
//
// Ce que ces tests éprouvent tient en une phrase : **un usage affiché est un
// usage réel**, et ce qui n'est pas calculé se dit absent plutôt que nul. Le
// reste — la jointure par référence, la non-fusion des homonymes, la protection
// d'un média lié — existait déjà et est éprouvé ici depuis la surface commune,
// celle que l'auteur regarde.
//
// Tout est pur : ni React, ni Tauri, ni moteur d'affichage.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGraphIndex } from '../src/store/advancedGraphView/graphViewModel.js';
import {
  advancedMediaUsageForPaths,
  describeAdvancedMediaUsages,
} from '../src/store/advancedAuthoring/mediaUsage.js';
import {
  collectMediaLibrary,
  executeMediaDeletion,
  isMediaHeldByProject,
} from '../src/store/mediaLibrary.js';
import {
  collectMissingMedia,
  planAdvancedRelink,
  relinkProjectMedia,
  shouldProposeMissingMediaRelink,
} from '../src/store/missingMediaRelink.js';
import { mediaTagsFor, withMediaTag, withoutMediaTag } from '../src/store/mediaTags.js';
import { isProjectOpen } from '../src/store/projectWorkState.js';
import { pathKey } from '../src/utils/fileUtils.js';
import { presence, sampleView, stage } from './advancedViewFixtures.mjs';

const DIR = '/projets/renard';
const COMMUN = `${DIR}/medias/commun.mp3`;

// `commun.mp3` est employé par deux Écrans de `sampleView` — c'est ce partage
// qui rend la question « où ce média est-il utilisé ? » non triviale.
function advancedProject(bindings = [
  { assetRef: 'commun.mp3', path: COMMUN, status: 'resolved' },
]) {
  return {
    schemaVersion: 4,
    authoringMode: 'advanced',
    projectType: 'advanced',
    projectName: 'renard-avance',
    rootEntries: [],
    authoring: {
      payload: '{"payloadVersion":1}',
      editorState: { version: 1 },
      mediaBindings: bindings,
    },
  };
}

function usagesOf(view = sampleView()) {
  return describeAdvancedMediaUsages(view, buildGraphIndex(view));
}

function catalogOf(project, advancedUsages, statusByPath = { [COMMUN]: true }) {
  return collectMediaLibrary({ project, statusByPath, advancedUsages });
}

// ── L'adaptateur : du DTO vers ce que la médiathèque sait lire ───────────────

test('les usages remontés nomment l\'Écran et le champ, et non la référence', () => {
  const described = usagesOf();
  assert.equal(described.length, 1);
  assert.equal(described[0].assetRef, 'commun.mp3');
  assert.deepEqual(described[0].usages.map((usage) => [usage.label, usage.field]), [
    ['Entrée', 'audio'],
    ['Cible', 'audio'],
  ]);
});

test('un Écran sans nom retombe sur son chemin d\'auteur plutôt que sur un nom inventé', () => {
  const anonyme = stage('anonyme', {
    name: presence(undefined),
    fallbackLabel: '',
    audio: { presence: 'value', assetRef: 'seul.mp3' },
  });
  const view = {
    ...sampleView(),
    stages: [anonyme],
    actions: [],
    edges: [],
    mediaRefs: [{ assetRef: 'seul.mp3', usages: [{ nodePath: anonyme.path, field: 'audio' }] }],
  };
  const described = describeAdvancedMediaUsages(view, buildGraphIndex(view));
  // `nodeLabel` rend l'identifiant source en dernier recours : c'est une valeur
  // réelle du document, pas un libellé fabriqué.
  assert.deepEqual(described[0].usages.map((usage) => usage.label), ['anonyme']);
});

test('une vue absente rend null — « non calculé » n\'est pas « aucun usage »', () => {
  assert.equal(describeAdvancedMediaUsages(null, null), null);
  assert.equal(describeAdvancedMediaUsages(undefined), null);
  // Une vue lue mais sans aucune référence, elle, rend bien une liste vide.
  assert.deepEqual(describeAdvancedMediaUsages({ mediaRefs: [] }, null), []);
});

// ── La médiathèque : trois états, et ils ne se confondent pas ────────────────

test('un média d\'un projet graphe affiche ses usages réels, nœud et champ', () => {
  const catalog = catalogOf(advancedProject(), usagesOf());
  assert.equal(catalog.length, 1);
  const [item] = catalog;
  assert.equal(item.path, COMMUN);
  assert.equal(item.inProject, true);
  assert.equal(item.usageKnown, true);
  assert.equal(item.usedCount, 2);
  assert.equal(item.projectUsedCount, 2);
  assert.deepEqual(item.usages.map((usage) => usage.label), ['Entrée · audio', 'Cible · audio']);
});

test('sans vue lue, les usages sont déclarés non calculés et jamais comptés à zéro', () => {
  const [item] = catalogOf(advancedProject(), null);
  assert.equal(item.usageKnown, false);
  assert.deepEqual(item.usages, []);
  // Le média reste protégé : c'est la liaison qui le dit, pas le compte.
  assert.equal(item.inProject, true);
  assert.equal(isMediaHeldByProject(item), true);
});

test('une liaison que le document ne cite plus rend un zéro réellement calculé', () => {
  const project = advancedProject([
    { assetRef: 'commun.mp3', path: COMMUN, status: 'resolved' },
    { assetRef: 'oublie.mp3', path: `${DIR}/medias/oublie.mp3`, status: 'resolved' },
  ]);
  const catalog = catalogOf(project, usagesOf(), { [COMMUN]: true, [`${DIR}/medias/oublie.mp3`]: true });
  const oublie = catalog.find((item) => item.name === 'oublie.mp3');
  assert.equal(oublie.usageKnown, true);
  assert.equal(oublie.projectUsedCount, 0);
  assert.deepEqual(oublie.usages, []);
  // Zéro usage ne veut pas dire « supprimable » : la liaison existe toujours,
  // et aucun geste ne la retire.
  assert.equal(isMediaHeldByProject(oublie), true);
});

test('une référence du document sans fichier lié reste visible, dans son état propre', () => {
  // Aucune liaison : la référence est citée, rien ne la résout.
  const catalog = catalogOf(advancedProject([]), usagesOf(), {});
  assert.equal(catalog.length, 1);
  const [item] = catalog;
  assert.equal(item.name, 'commun.mp3');
  assert.equal(item.path, '');
  assert.equal(item.unbound, true);
  assert.equal(item.exists, false);
  assert.equal(item.kind, 'audio');
  assert.equal(item.usedCount, 2);
  assert.deepEqual(item.usages.map((usage) => usage.label), ['Entrée · audio', 'Cible · audio']);
});

test('une liaison déclarée sans chemin rend le même état que l\'absence de liaison', () => {
  const catalog = catalogOf(advancedProject([{ assetRef: 'commun.mp3', path: null, status: 'missing' }]), usagesOf(), {});
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].unbound, true);
  assert.equal(catalog[0].path, '');
});

test('deux médias homonymes dans deux dossiers ne fusionnent pas', () => {
  const autre = `${DIR}/voix/commun.mp3`;
  const view = sampleView();
  const cible = view.stages[1];
  view.stages[1] = { ...cible, image: { presence: 'value', assetRef: 'z9y8x7.mp3' } };
  view.mediaRefs = [
    ...view.mediaRefs,
    { assetRef: 'z9y8x7.mp3', usages: [{ nodePath: cible.path, field: 'image' }] },
  ];
  // Deux références distinctes, deux fichiers de **même nom** dans deux
  // dossiers. La jointure se fait par référence : elles ne se rejoignent pas.
  const project = advancedProject([
    { assetRef: 'commun.mp3', path: COMMUN, status: 'resolved' },
    { assetRef: 'z9y8x7.mp3', path: autre, status: 'resolved' },
  ]);
  const catalog = catalogOf(project, usagesOf(view), { [COMMUN]: true, [autre]: true });
  assert.equal(catalog.length, 2);
  assert.deepEqual(catalog.map((item) => item.path).sort(), [COMMUN, autre].sort());
  assert.deepEqual(catalog.map((item) => item.usedCount).sort(), [1, 2]);
});

test('la suppression disque reste refusée, et le dialogue pose la même question que l\'exécution', async () => {
  for (const advancedUsages of [usagesOf(), null]) {
    const [item] = catalogOf(advancedProject(), advancedUsages);
    let deleted = false;
    const result = await executeMediaDeletion({
      item,
      deleteFromDisk: true,
      deleteDisk: async () => { deleted = true; },
    });
    assert.deepEqual([result.removed, result.blocked, deleted], [false, true, false]);
    // Le dialogue filtrait sur le compte d'usages ; il aurait donc proposé un
    // retrait que l'exécution refuse, dès que le compte est à zéro sans que la
    // liaison le soit. Les deux surfaces lisent désormais le même prédicat.
    assert.equal(isMediaHeldByProject(item), result.blocked);
  }
});

// ── Les files : « non utilisé » est une affirmation, pas un repli ────────────

const samePath = (a, b) => pathKey(a) === pathKey(b);

test('un fichier lié au document est reconnu, avec ou sans détail des écrans', () => {
  const project = advancedProject();
  const known = advancedMediaUsageForPaths(project, usagesOf(), [COMMUN], samePath);
  assert.deepEqual([known.bound, known.known, known.usages.length], [true, true, 2]);

  const unknown = advancedMediaUsageForPaths(project, null, [COMMUN], samePath);
  assert.deepEqual([unknown.bound, unknown.known, unknown.usages.length], [true, false, 0]);
});

test('aucune liaison sur ce chemin est un fait, pas une ignorance', () => {
  const project = advancedProject();
  const absent = advancedMediaUsageForPaths(project, usagesOf(), [`${DIR}/ia/voix.wav`], samePath);
  // La liste des liaisons est complète : ce « non » se dit sans mentir.
  assert.deepEqual([absent.bound, absent.known], [false, true]);
});

test('un projet sans liaison ne répond rien plutôt que « non utilisé »', () => {
  assert.equal(advancedMediaUsageForPaths(advancedProject([]), usagesOf(), [COMMUN], samePath), null);
  assert.equal(advancedMediaUsageForPaths(advancedProject(), usagesOf(), [], samePath), null);
});

// ── La reliaison : un plan de gestes, jamais une réécriture ──────────────────

test('la reliaison d\'un projet graphe se rend en gestes, adressés par référence', () => {
  const project = advancedProject([
    { assetRef: 'commun.mp3', path: COMMUN, status: 'missing' },
    { assetRef: 'intact.mp3', path: `${DIR}/medias/intact.mp3`, status: 'resolved' },
  ]);
  const plan = planAdvancedRelink(project, { [COMMUN]: '/ailleurs/commun.mp3' });
  assert.deepEqual(plan, [{
    assetRef: 'commun.mp3',
    path: '/ailleurs/commun.mp3',
    previousPath: COMMUN,
  }]);
  // Le plan ne touche rien : c'est sa raison d'être.
  assert.equal(project.authoring.mediaBindings[0].path, COMMUN);
  assert.deepEqual(planAdvancedRelink(project, {}), []);
});

test('une référence partagée par plusieurs Écrans ne produit qu\'un seul geste', () => {
  // `commun.mp3` est employé deux fois dans la vue ; le geste repointe la
  // référence entière, donc un pas suffit — et un seul pas d'annulation.
  const plan = planAdvancedRelink(advancedProject(), { [COMMUN]: '/ailleurs/commun.mp3' });
  assert.equal(plan.length, 1);
});

test('le chemin de réécriture directe reste celui du Libre, et il est inchangé', () => {
  const free = {
    schemaVersion: 3,
    authoringMode: 'free',
    projectType: 'pack',
    rootAudio: COMMUN,
    rootEntries: [],
  };
  const relinked = relinkProjectMedia(free, { [COMMUN]: '/ailleurs/commun.mp3' });
  assert.equal(relinked.rootAudio, '/ailleurs/commun.mp3');
  assert.equal(free.rootAudio, COMMUN);
  // Un projet Libre n'a pas de liaison : son plan avancé est vide, et c'est ce
  // qui fait que le hook choisit l'autre chemin sans avoir à le deviner.
  assert.deepEqual(planAdvancedRelink(free, { [COMMUN]: '/ailleurs/commun.mp3' }), []);
});

// ── Les étiquettes : elles n'ont jamais eu besoin d'un arbre ─────────────────

test('une étiquette se pose et se retire sur un média de projet graphe', () => {
  const [item] = catalogOf(advancedProject(), usagesOf());
  let tags = withMediaTag({}, item.path, 'générique');
  assert.deepEqual(mediaTagsFor(tags, item.path), ['générique']);
  // La médiathèque relit par le même chemin que celui qu'elle affiche.
  tags = withMediaTag(tags, item.path, 'à refaire');
  assert.deepEqual(mediaTagsFor(tags, item.path), ['générique', 'à refaire']);
  tags = withoutMediaTag(tags, item.path, 'générique');
  assert.deepEqual(mediaTagsFor(tags, item.path), ['à refaire']);
});

test('une référence sans fichier lié n\'offre pas d\'étiquette, faute de chemin', () => {
  const [unbound] = catalogOf(advancedProject([]), usagesOf(), {});
  assert.equal(unbound.path, '');
  // Poser une étiquette sur un chemin vide ne ferait rien : les surfaces la
  // masquent, et le module lui-même rend la carte inchangée.
  const tags = { autre: ['x'] };
  assert.equal(withMediaTag(tags, unbound.path, 'générique'), tags);
});

// ── La proposition de relier : elle s'ouvre enfin côté graphe ────────────────

const relinkInputs = {
  savePath: '/projets/renard.mbah',
  pathAuditPending: false,
  missingMedia: [{ path: COMMUN }],
  missingMediaSignature: 'a',
  dismissedMissingMediaSignature: '',
};

test('la proposition de relier s\'ouvre pour un projet graphe comme pour un projet Libre', () => {
  const graphe = advancedProject([{ assetRef: 'commun.mp3', path: COMMUN, status: 'missing' }]);
  // Le défaut visé : les manquants étaient comptés et la bannière
  // ne s'ouvrait pas.
  assert.equal(collectMissingMedia(graphe, { [COMMUN]: false }).length, 1);
  assert.equal(isProjectOpen(graphe), true);
  assert.equal(shouldProposeMissingMediaRelink({ ...relinkInputs, projectOpen: true }), true);
});

test('les autres conditions de la proposition sont inchangées', () => {
  assert.equal(shouldProposeMissingMediaRelink({ ...relinkInputs, projectOpen: false }), false);
  assert.equal(shouldProposeMissingMediaRelink({ ...relinkInputs, projectOpen: true, savePath: null }), false);
  assert.equal(shouldProposeMissingMediaRelink({ ...relinkInputs, projectOpen: true, pathAuditPending: true }), false);
  assert.equal(shouldProposeMissingMediaRelink({ ...relinkInputs, projectOpen: true, missingMedia: [] }), false);
  // Une liste déjà rejetée ne se represente pas tant qu'elle n'a pas changé.
  assert.equal(shouldProposeMissingMediaRelink({
    ...relinkInputs, projectOpen: true, dismissedMissingMediaSignature: 'a',
  }), false);
});

// ── Le témoin Libre ─────────────────────────────────────────────────────────

test('un projet Libre ne voit passer ni usages avancés ni état non calculé', () => {
  const free = {
    schemaVersion: 3,
    authoringMode: 'free',
    projectType: 'pack',
    rootAudio: COMMUN,
    rootEntries: [{ id: 'histoire-1', type: 'story', name: 'Le renard', audio: COMMUN }],
  };
  const catalog = collectMediaLibrary({ project: free, statusByPath: { [COMMUN]: true } });
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0].usageKnown, true);
  assert.equal(catalog[0].projectUsedCount, 2);
  assert.deepEqual(catalog[0].usages.map((usage) => usage.label), ['Accueil', 'Le renard']);
  // Et la liste d'usages avancés, si elle arrivait, ne lui ajouterait rien :
  // il n'a aucune liaison à joindre.
  const withUsages = collectMediaLibrary({ project: free, statusByPath: { [COMMUN]: true }, advancedUsages: usagesOf() });
  assert.deepEqual(withUsages.map((item) => item.path), [COMMUN]);
});
