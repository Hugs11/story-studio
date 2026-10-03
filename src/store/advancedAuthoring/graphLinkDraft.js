// Brouillon pur du câblage direct du graphe.
//
// Les prises visibles décrivent les deux primitives réelles du dialecte :
// une transition d'Écran vers une Action, ou une nouvelle occurrence d'Action
// vers un Écran. La géométrie de la carte n'invente aucune troisième relation.

import {
  RANDOM_OPTION_INDEX,
  advancedGestures,
  optionTarget,
} from '../projectModel/advancedGestures.js';
import { ACTION_KIND, STAGE_KIND, isEntryStage } from '../advancedGraphView/graphViewModel.js';

export const GRAPH_LINK_PORTS = Object.freeze({
  STAGE_OK: 'stage-ok',
  STAGE_HOME: 'stage-home',
  ACTION_OPTION: 'action-option',
});

export const GRAPH_LINK_DROP = Object.freeze({
  EXISTING: 'existing',
  EMPTY: 'empty',
  INVALID: 'invalid',
  INACTIVE: 'inactive',
});

function enabled(field) {
  return field?.presence === 'value' && field.value === true;
}

export function graphLinkPorts(entry) {
  if (!entry) return [];
  if (entry.kind === STAGE_KIND) {
    const controls = entry.node.controls ?? {};
    // Tirer depuis une prise dit déjà qu'on veut cette sortie : si la touche
    // qui la rend jouable est éteinte, le raccord l'allume dans le même geste.
    // Pour la prise OK, c'est OK qui s'allume, jamais la lecture automatique,
    // qui changerait la façon dont l'Écran se joue. Seul un Écran sans objet de
    // contrôles garde ses prises inactives : les allumer inventerait les autres
    // valeurs, et c'est à l'auteur de les choisir.
    const settable = controls.presence === 'value';
    return [
      {
        id: GRAPH_LINK_PORTS.STAGE_OK,
        slot: 'ok',
        active: settable,
        activateControl: !enabled(controls.ok) && !enabled(controls.autoplay),
        label: 'Raccorder la suite du parcours (okTransition)',
        control: enabled(controls.autoplay) ? 'autoplay' : 'ok',
      },
      {
        id: GRAPH_LINK_PORTS.STAGE_HOME,
        slot: 'home',
        active: settable,
        activateControl: !enabled(controls.home),
        label: 'Raccorder le bouton Accueil (homeTransition)',
        control: 'home',
      },
    ];
  }
  if (entry.kind === ACTION_KIND) {
    const options = entry.node.options ?? [];
    const missingOptionIndex = options.findIndex((option) => option.target?.presence === 'null');
    return [{
      id: GRAPH_LINK_PORTS.ACTION_OPTION,
      active: true,
      label: missingOptionIndex >= 0 ? 'Raccorder le choix manquant' : 'Ajouter un choix',
      suggestedIndex: missingOptionIndex >= 0 ? missingOptionIndex : options.length,
      missingOptionIndex: missingOptionIndex >= 0 ? missingOptionIndex : null,
    }];
  }
  return [];
}

// Le brouillon vit **en coordonnées de graphe**, des deux bouts.
//
// Il tenait son origine en pixels écran, relevée une fois à l'appui. Or le
// geste que ce brouillon sert est précisément celui qui traverse le document :
// on attrape une prise, on dézoome pour atteindre l'autre bout, on lâche. Dès
// que la caméra bougeait, l'origine restait accrochée à une position d'écran
// périmée et le trait se décrochait de sa prise.
//
// En coordonnées de graphe, l'ancre ne bouge plus : c'est la vue qui bouge
// autour d'elle, et le tracé la reprojette à chaque image. Le point d'arrivée
// suit la même convention, ce qui évite d'avoir deux unités dans le même objet
// et donne gratuitement le point de dépôt attendu par le geste.
export function startGraphLinkDraft(index, sourcePath, portId, anchor) {
  const source = index?.byPath.get(sourcePath) ?? null;
  const port = graphLinkPorts(source).find((candidate) => candidate.id === portId) ?? null;
  if (!source || !port) return null;
  if (!port.active) {
    return {
      kind: GRAPH_LINK_DROP.INACTIVE,
      sourcePath,
      sourceKind: source.kind,
      portId,
      control: port.control,
    };
  }
  return {
    kind: 'draft',
    sourcePath,
    sourceKind: source.kind,
    sourceId: source.kind === STAGE_KIND ? source.node.uuid : source.node.id,
    portId,
    slot: port.slot ?? null,
    activateControl: port.activateControl ?? false,
    suggestedIndex: port.suggestedIndex ?? null,
    missingOptionIndex: port.missingOptionIndex ?? null,
    anchor: { x: anchor.x, y: anchor.y },
    pointer: { x: anchor.x, y: anchor.y },
  };
}

export function moveGraphLinkDraft(draft, point) {
  if (draft?.kind !== 'draft') return draft;
  return { ...draft, pointer: { x: point.x, y: point.y } };
}

export function resolveGraphLinkDrop(index, draft, targetPath, graphPoint) {
  if (draft?.kind !== 'draft') return null;
  if (!targetPath) {
    return {
      kind: GRAPH_LINK_DROP.EMPTY,
      sourcePath: draft.sourcePath,
      sourceKind: draft.sourceKind,
      sourceId: draft.sourceId,
      portId: draft.portId,
      slot: draft.slot,
      activateControl: draft.activateControl,
      suggestedIndex: draft.suggestedIndex,
      missingOptionIndex: draft.missingOptionIndex,
      graphPoint,
    };
  }
  const target = index?.byPath.get(targetPath) ?? null;
  if (!target || target.path === draft.sourcePath || target.kind === draft.sourceKind) {
    return {
      kind: GRAPH_LINK_DROP.INVALID,
      sourcePath: draft.sourcePath,
      targetPath,
      reason: draft.sourceKind === STAGE_KIND
        ? 'Un Écran se raccorde à une liste de choix.'
        : 'Une liste de choix se raccorde à un Écran.',
    };
  }
  // L'Écran d'entrée n'est jamais le choix d'une liste : le moteur refuserait
  // le geste, le trait le dit avant.
  if (draft.sourceKind === ACTION_KIND && isEntryStage(target)) {
    return {
      kind: GRAPH_LINK_DROP.INVALID,
      sourcePath: draft.sourcePath,
      targetPath,
      reason: 'L’Écran d’entrée ne peut pas être le choix d’une liste : on y revient par le bouton Accueil laissé sans destination.',
    };
  }
  return {
    kind: GRAPH_LINK_DROP.EXISTING,
    sourcePath: draft.sourcePath,
    sourceKind: draft.sourceKind,
    sourceId: draft.sourceId,
    targetPath,
    targetKind: target.kind,
    targetId: target.kind === STAGE_KIND ? target.node.uuid : target.node.id,
    targetOptionCount: target.kind === ACTION_KIND ? (target.node.options?.length ?? 0) : null,
    portId: draft.portId,
    slot: draft.slot,
    activateControl: draft.activateControl,
    suggestedIndex: draft.suggestedIndex,
    missingOptionIndex: draft.missingOptionIndex,
  };
}

// Un raccord vers un nœud existant est appliqué dès le relâchement du trait.
// Seule la création d'un nœud au bout du trait ouvre encore une fenêtre.
export function isGraphLinkAutoApplyable(intent) {
  if (intent?.kind !== GRAPH_LINK_DROP.EXISTING) return false;
  // Ni le remplacement ni l'activation d'une touche ne demandent confirmation.
  // Tirer depuis une touche déjà raccordée remplace l'ancien lien : il saute
  // sous les yeux de l'auteur, Ctrl+Z le rend, et ce que son départ casse —
  // une Action que plus rien ne rejoint — passe par « À corriger ». Tirer
  // depuis la prise OK ou HOME d'un Écran où cette touche est éteinte dit déjà
  // qu'on veut cette sortie : le geste allume la touche avec le raccord, en
  // une annulation.
  //
  // Vers une Action à plusieurs destinations, le lien arrive sur la première,
  // le cas normal : l'auteur change ce premier choix dans le panneau de
  // l'Écran (« Changer d'Action… »), qui le règle pour ce seul lien.
  if (intent.sourceKind === STAGE_KIND) return intent.targetKind === ACTION_KIND;
  return intent.sourceKind === ACTION_KIND && intent.targetKind === STAGE_KIND;
}

export function buildExistingGraphLinkGesture(intent, decision) {
  if (intent?.kind !== GRAPH_LINK_DROP.EXISTING) {
    throw new TypeError('Le raccord doit viser un nœud existant.');
  }
  if (intent.sourceKind === STAGE_KIND) {
    if (intent.targetOptionCount === 0) {
      return advancedGestures.connectStageToEmptyAction(
        intent.sourceId,
        intent.slot,
        intent.targetId,
        intent.activateControl,
      );
    }
    if (intent.targetOptionCount === 1) {
      return advancedGestures.setStageTransition(
        intent.sourceId,
        intent.slot,
        advancedGestures.transitionTo(intent.targetId, 0),
        intent.activateControl,
      );
    }
    // Sans décision, la première destination : c'est ce que fait un raccord
    // appliqué dès le relâchement du trait.
    const selection = decision?.selection === 'random'
      ? RANDOM_OPTION_INDEX
      : Number(decision?.selection ?? 0);
    if (decision?.selection !== 'random' && (!Number.isInteger(selection) || selection < 0)) {
      throw new TypeError('Choisir un choix d’arrivée fixe ou tiré au sort.');
    }
    return advancedGestures.setStageTransition(
      intent.sourceId,
      intent.slot,
      advancedGestures.transitionTo(intent.targetId, selection),
      intent.activateControl,
    );
  }
  // Une destination laissée libre par le retrait d'un Écran garde son rang et
  // toutes les transitions entrantes. Le prochain trait depuis cette Action
  // la complète, sans ajouter une option qui laisserait l'erreur en place.
  if (intent.missingOptionIndex !== null && intent.missingOptionIndex !== undefined) {
    return advancedGestures.setActionOptionTarget(
      intent.sourceId,
      intent.missingOptionIndex,
      optionTarget.stage(intent.targetId),
    );
  }
  // Le rang par défaut est celui que porte la prise : `suggestedIndex` vaut le
  // nombre d'options de l'Action quand aucune destination ne manque.
  //
  // Sans ce repli, toute arrivée sur un Écran levait : l'application appelle
  // ce constructeur avec une décision **vide** dès que le raccord s'applique
  // seul, et `Number(undefined)` ne passe aucune des deux gardes ci-dessous.
  // Le dialogue, lui, continue de passer son propre rang.
  //
  // Le rang absent est écarté avant la conversion : `Number(null)` vaut zéro,
  // et un rang inconnu se rangerait donc **au début** sans rien signaler.
  const proposed = decision?.insertionIndex ?? intent.suggestedIndex ?? null;
  const insertionIndex = proposed === null ? Number.NaN : Number(proposed);
  if (!Number.isInteger(insertionIndex) || insertionIndex < 0) {
    throw new TypeError('Choisir la place du nouveau choix.');
  }
  return advancedGestures.insertActionOption(
    intent.sourceId,
    insertionIndex,
    optionTarget.stage(intent.targetId),
  );
}

export function layoutEntriesFromPositions(index, positions) {
  return positions.map(({ path, x, y }) => {
    const entry = index?.byPath.get(path);
    if (!entry) throw new TypeError(`Nœud absent de la disposition : ${path}`);
    return {
      node: entry.kind === STAGE_KIND
        ? { kind: STAGE_KIND, id: entry.node.uuid }
        : { kind: ACTION_KIND, id: entry.node.id },
      position: { x, y },
    };
  });
}
