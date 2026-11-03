// Listes natives de l'éditeur graphe avancé, migrées vers le composant Select (lot select B).
//
// Les surfaces historiques (`i18nGraph*SourceFixture.mjs`) viennent de la source d'origine (git show BASE) rendue
// avec des <select> natifs : toutes les <option> y figurent. Le composant Select est fermé par défaut, seule l'option
// choisie est dans le DOM. Ce module décrit, pour chaque scénario, les listes natives de la source d'origine (libellés
// dans l'ordre, option choisie suffixée de « * ») ; il sert à deux choses :
//  - ramener la surface historique à l'option choisie (`collapseSurface`, `collapseSegments`), en exigeant que la liste
//    complète y figure bien, dans l'ordre ;
//  - être comparé, liste ouverte, aux options réelles du Select monté (scripts/selectMigrationLotB.test.mjs).
// Les libellés ci-dessous sont lus dans les fixtures de BASE, jamais dans le code qu'ils vérifient.
import assert from 'node:assert/strict';

const list = (...labels) => ({
  options: labels.map(label => label.replace(/\*$/, '')),
  selected: labels.findIndex(label => label.endsWith('*')),
  // Option désactivée de la source d'origine, devenue le `placeholder` de Select : absente de la liste ouverte.
  placeholder: false,
});
const withPlaceholder = (entry) => ({ ...entry, placeholder: true });

const NODE = list('— choisir —*', '_AUTHOR_0_', '_AUTHOR_1_', '_AUTHOR_2_');
const NODE_LIST = list('— choisir —*', 'Liste sans nom 1 (sans nom)');
const NODE_LIST_CHOSEN = list('— choisir —', 'Liste sans nom 1 (sans nom)*');
const PRESENCE = list('Activé', 'Désactivé', 'Non défini (null)', 'Non défini (absent)*');
const LANDING_UNKNOWN = withPlaceholder(list('choix illisible*', '1/2 · Écran à choisir', '2/2 · _AUTHOR_', 'Au hasard, à chaque fois'));
const LANDING_MISSING = withPlaceholder(list('choix 9/2 absent*', '1/2 · Écran à choisir', '2/2 · _AUTHOR_', 'Au hasard, à chaque fois'));
const LANDING_RANDOM = list('1/2 · Écran à choisir', '2/2 · _AUTHOR_', 'Au hasard, à chaque fois*');
const LANDING_WIRED = list('1/2 · _AUTHOR_1_*', '2/2 · _AUTHOR_1_', 'Au hasard, à chaque fois');
const LANDING_WIRED_RANDOM = list('1/2 · _AUTHOR_1_', '2/2 · _AUTHOR_1_', 'Au hasard, à chaque fois*');
const FIXED = list('1/2 · _AUTHOR_1_*', '2/2 · _AUTHOR_1_');
const COMPLETION = (chosen) => ['— à définir —', 'Activé', 'Désactivé'].map((label, rank) => (rank === chosen ? `${label}*` : label));
const completion = (...chosen) => chosen.map(rank => list(...COMPLETION(rank)));
// Molette, OK, Accueil, Pause, Lecture automatique : l'état ouvert du banc (wheel, ok vrais ; home, pause, autoplay faux).
const COMPLETIONS = completion(1, 1, 2, 2, 2);

// Pour chaque banc, les listes de chaque scénario dans l'ordre d'apparition dans la surface.
const common = {
  NodePicker: [NODE],
  SquareOneRepairForm: [NODE],
  LandingSelect: [LANDING_UNKNOWN],
  LandingMissing: [LANDING_MISSING],
  LandingRandom: [LANDING_RANDOM],
  ActionSelectionFields: [list('1/2 · Écran à choisir*', '2/2 · Écran à choisir')],
  GraphLinkDialog: [list('— à choisir plus tard —*', '_AUTHOR_1_', '_AUTHOR_2_')],
  PickerDuplicate: [list('— choisir —', '_AUTHOR_0_', '_AUTHOR_1_ — identifiant dupliqué*', '_AUTHOR_2_')],
  LinkFromList: [list('À la fin*', 'Au début', 'Avant le choix 2')],
  ControlRow: [PRESENCE],
  WheelEmpty: [PRESENCE],
  WheelNeighbours: [PRESENCE],
  DestinationsAbsent: [PRESENCE, PRESENCE, PRESENCE],
  DestinationsEntry: [PRESENCE, PRESENCE],
};
export const GRAPH_NATIVE_LISTS = {
  surface: {
    construction: [list('Scène*', 'Choix', 'Séquence', 'Tirage au sort'), list('— à raccorder plus tard —*', '_AUTHOR_1_', '_AUTHOR_2_'), list('— créer sans arrivée —*', '_AUTHOR_0_', '_AUTHOR_1_', '_AUTHOR_2_')],
  },
  editing: {
    ...common,
    ActionPanel: [list('1/2 · _AUTHOR_1_*', '2/2 · _AUTHOR_1_', 'Au hasard, à chaque fois')],
    StagePanel: [PRESENCE, PRESENCE, PRESENCE, PRESENCE, PRESENCE],
    DestinationsWired: [PRESENCE, PRESENCE, LANDING_WIRED_RANDOM, PRESENCE, LANDING_WIRED_RANDOM],
  },
  opened: {
    ...common,
    ControlsCompletion: COMPLETIONS,
    ControlPartial: COMPLETIONS,
    ActionPanel: [
      list('— aucun Écran —*', '_AUTHOR_1_', '_AUTHOR_2_'), list('— aucun Écran —*', '_AUTHOR_1_', '_AUTHOR_2_'),
      LANDING_WIRED, list('Sa suite du parcours (OK ou fin du son)*', 'Son bouton Accueil'), NODE, FIXED,
    ],
    StagePanel: [...COMPLETIONS, PRESENCE, PRESENCE, NODE_LIST, PRESENCE, PRESENCE, PRESENCE, NODE_LIST],
    ArrivalsEmpty: [NODE_LIST],
    ArrivalsReachable: [NODE_LIST],
    ArrivalsFolded: [NODE_LIST],
    DestinationsAbsent: [PRESENCE, PRESENCE, NODE_LIST, PRESENCE],
    DestinationsEntry: [PRESENCE, PRESENCE, NODE_LIST],
    DestinationsWired: [PRESENCE, PRESENCE, LANDING_WIRED_RANDOM, NODE_LIST_CHOSEN, PRESENCE, LANDING_WIRED_RANDOM],
  },
};

const sameRun = (items, run, from) => run.every((label, offset) => items[from + offset] === label);

// Texte à plat : la liste complète, séparée par des espaces, est remplacée par l'option choisie.
function collapseText(text, lists, where) {
  let cursor = 0;
  let result = text;
  for (const { options, selected } of lists) {
    const run = options.join(' ');
    let at = result.indexOf(run, cursor);
    while (at >= 0 && !((at === 0 || result[at - 1] === ' ') && (at + run.length === result.length || result[at + run.length] === ' '))) at = result.indexOf(run, at + 1);
    assert.ok(at >= 0, `${where} : liste native absente de la surface d'origine : ${run}`);
    result = result.slice(0, at) + options[selected] + result.slice(at + run.length);
    cursor = at + options[selected].length;
  }
  return result;
}

// Segments de texte (un par élément) : la suite des options est remplacée par l'option choisie.
function collapseSegmentList(segments, lists, where) {
  const result = [...segments];
  let cursor = 0;
  for (const { options, selected } of lists) {
    let at = -1;
    for (let i = cursor; i + options.length <= result.length; i += 1) if (sameRun(result, options, i)) { at = i; break; }
    assert.ok(at >= 0, `${where} : liste native absente des segments d'origine : ${options.join(' | ')}`);
    result.splice(at, options.length, options[selected]);
    cursor = at + 1;
  }
  return result;
}

export function collapseSurface(variant, name, surface) {
  const lists = GRAPH_NATIVE_LISTS[variant][name];
  if (!lists) return surface;
  return { ...surface, text: collapseText(surface.text, lists, `${variant}:${name}`) };
}

export function collapseSegments(variant, name, segments) {
  const lists = GRAPH_NATIVE_LISTS[variant][name];
  if (!lists) return segments;
  return { ...segments, text: collapseSegmentList(segments.text, lists, `${variant}:${name}`) };
}
