// Les deux sources du simulateur de graphe à plat, rendues dans **une seule**
// forme.
//
// Le simulateur sait déjà jouer un graphe à plat : boucles, Écrans partagés,
// Actions partagées, tirage aléatoire renouvelé à chaque entrée. Ce qui lui
// manquait n'était pas de la navigation, c'était une seconde provenance. Ce
// module la lui donne, et **aucune règle de navigation n'est écrite ici** : le
// choix d'une option reste `store/optionSelection.js`, seul interprète du
// dialecte, des deux côtés.
//
// Trois fabriques, une forme :
//
// - `packFlatGraph` lit le `story.json` d'une archive produite, tel que
//   `load_pack_zip` le rend ;
// - `documentFlatGraph` lit la **vue** du document en cours — le DTO de
//   `read_advanced_graph_view` — et ses liaisons média ;
// - `projectedFlatGraph` lit la projection d'un projet hiérarchique, rendue par
//   `project_pack_for_simulation` : le **vrai générateur** transforme l'arbre en
//   graphe à plat, sans produire d'archive. C'est ce qui permet à Story Studio
//   de n'avoir qu'un seul simulateur pour ses trois modes d'édition.
//
// La forme commune n'est pas une commodité de code : c'est la preuve du lot.
// Deux graphes bâtis dans la même forme se comparent nœud à nœud et référence
// à référence, ce qu'une seconde implémentation de navigation rendrait
// impossible à établir.
//
// **Ce que ce module ne fait pas.** Il n'ouvre pas le payload d'auteur — la vue
// est sa seule entrée côté document, comme pour toutes les surfaces du graphe.
// Il n'écrit rien, ne marque rien, ne réémet rien vers le document.

import { mediaBindingsByAssetRef } from '../../store/projectModel/mediaBindings.js';
import {
  OPTION_SELECTION,
  optionSelectionToDialectIndex,
  parseOptionSelection,
  resolveTransitionEntry,
} from '../../store/optionSelection.js';
import { toPackAssetName } from '../../utils/zipAssetName.js';

export const MEDIA_FROM_PACK = 'pack';
export const MEDIA_FROM_DISK = 'disk';

// Le nom réservé que Rust pose sur un emplacement dont le fichier n'existe pas
// encore. Miroir de `native_pack::simulation::SIMULATION_MISSING_ASSET`.
//
// Le générateur exige que chaque média annoncé soit préparé ; un projet en
// cours d'écriture n'a pas franchi cette porte, et c'est son état normal. Ce
// nom tient la place, et l'Écran se joue en silence — exactement ce que fait
// une référence sans liaison côté graphe.
export const PROJECTED_MISSING_ASSET = '__simulation_absent__';

// Les cinq contrôles, dans l'ordre du dialecte. Un pack exporté les porte tous ;
// un document en cours d'écriture peut n'en porter aucun.
const CONTROL_KEYS = ['wheel', 'ok', 'home', 'pause', 'autoplay'];

// Une requête média porte **toujours** sa référence de dialecte à côté de son
// transport. C'est elle, et non le chemin disque ou le nom d'asset, qui dit
// « quel média cet Écran désigne » : les deux sources la partagent à
// l'identique, et c'est ce qui rend leur comparaison possible.
function packMedia(assetRef, zipPath) {
  if (typeof assetRef !== 'string' || assetRef.trim() === '') return null;
  const assetName = toPackAssetName(assetRef);
  if (!assetName) return null;
  return { kind: MEDIA_FROM_PACK, assetRef, assetName, zipPath };
}

function diskMedia(assetRef, path) {
  if (typeof path !== 'string' || path.trim() === '') return null;
  return { kind: MEDIA_FROM_DISK, assetRef, path };
}

// Clé stable d'une requête média. Le simulateur en dépend pour ne pas relancer
// la lecture d'un son que rien n'a changé : les requêtes sont reconstruites à
// chaque assemblage de graphe, leur identité d'objet ne prouve rien.
export function mediaRequestKey(request) {
  if (!request) return '';
  return request.kind === MEDIA_FROM_PACK
    ? `pack:${request.zipPath ?? ''}:${request.assetName}`
    : `disk:${request.path}`;
}

function flatStage({ id, uuid, name, squareOne, controlSettings, audio, image, okTransition, homeTransition }) {
  return { id, uuid, name, squareOne, controlSettings, audio, image, okTransition, homeTransition };
}

// Le libellé d'écoute d'un Écran sans nom : « Stage N », N étant sa place dans
// l'archive produite — l'Écran d'entrée d'abord (PREP-005), puis les autres dans
// l'ordre du document. C'est la numérotation que l'import d'un pack Lunii pose
// sur ses Écrans, et qu'il ne réécrit pas à l'export : le graphe, l'écoute du
// projet et celle de l'archive disent donc le même nom. Rien n'entre dans le pack.
function labelUnnamedStages(stages, entryId) {
  const ids = [...stages.keys()];
  const order = entryId && stages.has(entryId)
    ? [entryId, ...ids.filter((id) => id !== entryId)]
    : ids;
  order.forEach((id, index) => {
    const stage = stages.get(id);
    if (!String(stage.name ?? '').trim()) stage.name = `Stage ${index + 1}`;
  });
}

// ── Source 1 : une archive produite ──────────────────────────────────────────

// La graphie du `story.json` est reprise telle quelle : un Écran y est identifié
// par `uuid`, avec repli historique sur `id`.
function packStageId(node) {
  return node.uuid || node.id;
}

/**
 * Le graphe d'un document du dialecte.
 *
 * `mediaFor` dit d'où viennent les octets. Par défaut, de l'archive `zipPath` —
 * c'est le cas d'un pack produit. La projection d'un projet hiérarchique passe
 * le sien : les mêmes Écrans, mais des fichiers sur le disque. Une seule
 * lecture du document pour les deux, parce que le document **est** le même.
 */
export function packFlatGraph(story, zipPath, mediaFor = null) {
  const media = mediaFor ?? ((assetRef) => packMedia(assetRef, zipPath));
  const nodes = Array.isArray(story?.stageNodes) ? story.stageNodes : [];
  const stages = new Map();
  for (const node of nodes) {
    const id = packStageId(node);
    if (!id) continue;
    stages.set(id, flatStage({
      id,
      uuid: id,
      name: typeof node.name === 'string' ? node.name : '',
      squareOne: node.squareOne === true,
      // Un pack sorti de la préparation porte ses cinq contrôles. Ils sont
      // repris tels quels, sans repli : inventer ici masquerait un pack
      // malformé au lieu de le faire entendre.
      controlSettings: node.controlSettings ?? {},
      audio: media(node.audio),
      image: media(node.image),
      okTransition: node.okTransition ?? null,
      homeTransition: node.homeTransition ?? null,
    }));
  }

  const actions = new Map();
  for (const node of Array.isArray(story?.actionNodes) ? story.actionNodes : []) {
    if (!node?.id) continue;
    actions.set(node.id, {
      id: node.id,
      options: Array.isArray(node.options) ? node.options : [],
    });
  }

  const entry = nodes.find((node) => node.squareOne === true);
  const entryId = entry ? packStageId(entry) : null;
  labelUnnamedStages(stages, entryId);

  return {
    stages,
    actions,
    entryId,
    title: typeof story?.title === 'string' ? story.title : '',
    // Une archive produite a franchi la préparation : elle n'a rien à déclarer
    // d'inachevé. La forme reste la même pour que les deux sources se comparent.
    readiness: emptyReadiness(),
  };
}

// ── Source 2 : le document en cours ──────────────────────────────────────────

const presenceValue = (field) => (field?.presence === 'value' ? field.value : null);

// L'identité d'un nœud de la vue est son **chemin**, pas son identifiant
// source : le dialecte tolère deux Écrans de même `uuid` (`uniqueId: false`),
// et les clés d'un graphe ne peuvent pas fusionner. `uuid` reste porté à côté,
// parce que c'est lui que l'archive produite emploiera.
function documentStage(stage, mediaFor) {
  const controlSettings = {};
  for (const key of CONTROL_KEYS) {
    // Décision utilisateur du 15 septembre 2026 : un contrôle que l'auteur n'a
    // pas encore renseigné **ne répond pas**, et l'écoute démarre quand même.
    // Refuser de jouer un document inachevé rendrait l'écoute indisponible
    // pendant l'essentiel du temps d'écriture, c'est-à-dire exactement quand
    // elle sert. Le bandeau le déclare ; il n'est pas deviné à l'oreille.
    controlSettings[key] = presenceValue(stage.controls?.[key]) === true;
  }
  return flatStage({
    id: stage.path,
    uuid: stage.uuid,
    name: presenceValue(stage.name) ?? stage.fallbackLabel ?? '',
    squareOne: presenceValue(stage.squareOne) === true,
    controlSettings,
    audio: mediaFor(stage.audio),
    image: mediaFor(stage.image),
    okTransition: documentTransition(stage.okTransition),
    homeTransition: documentTransition(stage.homeTransition),
  });
}

// La transition de la vue redevient la paire du dialecte que le simulateur
// consomme. `optionIndex` repasse par `optionSelectionToDialectIndex` plutôt
// que par un test de signe : la sentinelle RANDOM n'a qu'un seul interprète.
//
// Une Action introuvable (`actionPath: null`) donne une transition sans cible.
// Le simulateur reste alors où il est, ce qu'il fait déjà pour une archive dont
// une transition ne résout pas. Aucune cible de confort n'est inventée.
function documentTransition(transition) {
  if (transition?.presence !== 'value' || !transition.actionPath) return null;
  const optionIndex = optionSelectionToDialectIndex(transition.selection);
  if (optionIndex === null) return null;
  return { actionNode: transition.actionPath, optionIndex };
}

function emptyReadiness() {
  return {
    entryStatus: 'unique',
    incompleteControls: 0,
    unresolvedMedia: 0,
    danglingTransitions: 0,
  };
}

// Ce qu'un document en cours porte et qu'une archive produite ne peut pas
// porter. Compté ici, une fois, sur la vue : le bandeau le dit, le simulateur
// n'en sait rien et n'a pas à en savoir.
function documentReadiness(view, unresolvedMedia) {
  let incompleteControls = 0;
  let danglingTransitions = 0;
  for (const stage of view.stages ?? []) {
    if (stage.controls?.complete !== true) incompleteControls += 1;
    for (const transition of [stage.okTransition, stage.homeTransition]) {
      if (transition?.presence !== 'value') continue;
      if (!transition.actionPath || transition.withinBounds !== true) danglingTransitions += 1;
    }
  }
  for (const action of view.actions ?? []) {
    for (const option of action.options ?? []) {
      if (option.target?.dangling === true) danglingTransitions += 1;
    }
  }
  return {
    entryStatus: view.entry?.status ?? 'missing',
    incompleteControls,
    unresolvedMedia,
    danglingTransitions,
  };
}

/**
 * Le graphe du document en cours, prêt à être joué.
 *
 * `view` est le DTO de lecture ; `project` porte `authoring.mediaBindings`. La
 * jointure se fait par `assetRef` exactement, et deux
 * fichiers homonymes venus de deux dossiers n'y fusionnent pas.
 */
export function documentFlatGraph(view, project) {
  if (!view) return null;
  const bindings = mediaBindingsByAssetRef(project);
  let unresolvedMedia = 0;
  const seenUnresolved = new Set();
  const mediaFor = (slot) => {
    if (slot?.presence !== 'value' || !slot.assetRef) return null;
    const request = diskMedia(slot.assetRef, bindings.get(slot.assetRef)?.path);
    // Une référence sans fichier utilisable ne devient pas un silence muet :
    // elle se joue en silence **et** se compte, pour que le bandeau le dise.
    if (!request && !seenUnresolved.has(slot.assetRef)) {
      seenUnresolved.add(slot.assetRef);
      unresolvedMedia += 1;
    }
    return request;
  };

  const stages = new Map();
  for (const stage of view.stages ?? []) {
    stages.set(stage.path, documentStage(stage, mediaFor));
  }

  const actions = new Map();
  for (const action of view.actions ?? []) {
    actions.set(action.path, {
      id: action.path,
      // L'ordre sémantique des options est celui du DTO. Une option pendante
      // reste **à sa place** : la retirer décalerait les suivantes, et un
      // `optionIndex` d'auteur désignerait alors une autre destination.
      options: (action.options ?? []).map((option) => option.target?.stagePath ?? null),
    });
  }

  const entryId = view.entry?.status === 'unique' ? view.entry.stagePath : null;
  labelUnnamedStages(stages, entryId);

  return {
    stages,
    actions,
    entryId,
    title: presenceValue(view.metadata?.title) ?? '',
    readiness: documentReadiness(view, unresolvedMedia),
  };
}


// ── Source 3 : un projet hiérarchique, projeté par le générateur ─────────────

/**
 * Le graphe d'un projet du mode Libre, prêt à être joué.
 *
 * `projection` vient de `project_pack_for_simulation` : `{ story, media }`, où
 * `story` est le document du dialecte — la **même** forme qu'une archive
 * produite — et `media` dit où trouver les octets de chaque nom d'asset.
 *
 * Aucune navigation n'est dérivée ici. C'est tout l'objet de la fusion : la
 * navigation vient du générateur, donc ce que l'auteur entend est ce que la
 * production fabriquera. Le miroir JS `generatedNavigation.js` reste employé
 * par l'arbre, le diagramme et les éditeurs, mais plus par l'écoute.
 */
export function projectedFlatGraph(projection) {
  if (!projection?.story) return null;
  const byAssetName = new Map();
  for (const entry of projection.media ?? []) {
    byAssetName.set(entry.assetName, entry);
  }

  const mediaFor = (assetName) => {
    if (typeof assetName !== 'string' || assetName === '') return null;
    // Un emplacement dont le fichier n'existe pas encore : silence, sans
    // interrompre l'écoute ni inventer de chemin.
    if (assetName === PROJECTED_MISSING_ASSET) return null;
    const entry = byAssetName.get(assetName);
    if (!entry) return null;
    return entry.kind === MEDIA_FROM_PACK
      ? {
          kind: MEDIA_FROM_PACK,
          assetRef: assetName,
          assetName: entry.zipAssetName,
          zipPath: entry.zipPath,
        }
      : diskMedia(assetName, entry.path);
  };

  const graph = packFlatGraph(projection.story, null, mediaFor);

  // Ce qu'un projet en cours d'écriture a d'inachevé, compté sur le document
  // projeté. Le générateur écrit toujours cinq contrôles et une entrée unique :
  // seuls les médias absents restent à déclarer, et ils le sont par le nom
  // réservé que Rust a posé à leur place.
  const missing = new Set();
  for (const stage of projection.story.stageNodes ?? []) {
    if (stage.audio === PROJECTED_MISSING_ASSET) missing.add(`${stage.uuid}:audio`);
    if (stage.image === PROJECTED_MISSING_ASSET) missing.add(`${stage.uuid}:image`);
  }
  graph.readiness = { ...emptyReadiness(), unresolvedMedia: missing.size };

  // L'identité vient de la construction de l'Écran, même sans média. Un fichier
  // partagé ne dit pas quelle entrée joue ; il garde seulement ses octets.
  graph.entryIdByStage = new Map(Object.entries(projection.entryIdByStage ?? {}));
  return graph;
}

// ── Point de départ ──────────────────────────────────────────────────────────

// La liste de choix où figure un Écran, pour une écoute lancée sur lui : sans
// elle, la molette n'aurait rien à faire défiler. Sur la Lunii, on n'arrive
// jamais sur un Écran sans passer par une liste ; seul ce départ artificiel
// doit la retrouver. La première liste qui le propose, à sa première place.
function startContext(graph, stageId) {
  for (const [actionNodeId, action] of graph.actions) {
    const optionIdx = (action.options ?? []).indexOf(stageId);
    if (optionIdx >= 0) return { actionNodeId, optionIdx };
  }
  return null;
}

/**
 * L'Écran sur lequel l'écoute commence, et le contexte d'option qui l'accompagne.
 *
 * Trois entrées, une seule règle par entrée :
 *
 * - `startId` — l'auteur a désigné un Écran (« Simuler depuis ici »). Il
 *   gagne, y compris quand le document n'a aucune entrée désignée, et part
 *   dans la première liste qui le propose (`startContext`).
 * - `skipEntry` — le retour depuis le simulateur Libre, qui saute la couverture
 *   puis un éventuel Écran autoplay intermédiaire pour arriver sur la liste
 *   d'histoires. Comportement historique, déplacé ici sans être modifié.
 * - sinon, l'entrée du graphe.
 *
 * Un saut de confort ne consomme jamais un tirage exploratoire : seule une
 * sélection fixe est sautée, une sélection aléatoire suit le chemin normal
 * d'autoplay, qui tire à l'entrée réelle.
 */
export function resolveInitialStage(graph, { startId = null, skipEntry = false, drawSource = null } = {}) {
  if (!graph) return { stageId: null, context: null };
  if (startId && graph.stages.has(startId)) {
    return { stageId: startId, context: startContext(graph, startId) };
  }

  let stageId = graph.entryId;
  let context = null;
  if (!skipEntry || !stageId) return { stageId, context };

  const entryStage = graph.stages.get(stageId);
  const ok = entryStage?.okTransition;
  if (ok) {
    const step = resolveTransitionEntry(ok, graph.actions.get(ok.actionNode), drawSource);
    if (step) {
      stageId = step.target;
      context = { actionNodeId: ok.actionNode, optionIdx: step.index };
    }
  }

  const stage = graph.stages.get(stageId);
  const nextTransition = stage?.controlSettings?.autoplay ? stage.okTransition : null;
  if (nextTransition
    && parseOptionSelection(nextTransition.optionIndex)?.kind === OPTION_SELECTION.FIXED) {
    const step = resolveTransitionEntry(
      nextTransition,
      graph.actions.get(nextTransition.actionNode),
      drawSource,
    );
    const candidate = step ? graph.stages.get(step.target) : null;
    if (candidate && !candidate.controlSettings?.autoplay) {
      stageId = step.target;
      context = { actionNodeId: nextTransition.actionNode, optionIdx: step.index };
    }
  }

  return { stageId, context };
}
