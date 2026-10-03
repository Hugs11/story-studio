// Ce qu'un geste destructeur touche, calculé **avant** de le demander.
//
// Rust reste l'autorité : il refuse un plan incomplet et joint l'inventaire des
// chemins qui le motivent (`GestureError.references`). Ce module ne le double
// pas, il le précède — pour que l'auteur voie les références entrantes dans le
// dialogue qui lui demande de décider, au lieu de les découvrir dans un refus.
// Quand les deux divergent, c'est le refus qui gagne : l'interface reconstruit
// alors son plan sur `references`, jamais en découpant une phrase française.
//
// Les chemins d'auteur (`path`, `optionId`) sont des **jetons opaques** : ils
// sont comparés à l'octet et recopiés tels quels, jamais découpés pour en tirer
// un identifiant. Les identifiants viennent du DTO, où Rust les a mis.

import { ACTION_KIND, STAGE_KIND } from '../advancedGraphView/graphViewModel.js';
import { advancedGestures, optionResolution, presence } from '../projectModel/advancedGestures.js';

const TRANSITION_SLOT_BY_EDGE_KIND = Object.freeze({
  'stage-ok': 'ok',
  'stage-home': 'home',
});

function stageUuidOf(index, path) {
  const entry = index.byPath.get(path);
  return entry?.kind === STAGE_KIND ? entry.node.uuid : null;
}

function actionIdOf(index, path) {
  const entry = index.byPath.get(path);
  return entry?.kind === ACTION_KIND ? entry.node.id : null;
}

// Les occurrences d'options qui désignent un Écran, dans l'ordre des arêtes
// entrantes. Deux occurrences de la même Action vers le même Écran restent deux
// lignes : leur rang fait leur identité, et les fusionner perdrait exactement
// ce que le panneau cherche à montrer.
export function incomingOptionsForStage(index, stagePath) {
  const rows = [];
  for (const edge of index.incoming.get(stagePath) ?? []) {
    if (edge.kind !== 'action-option') continue;
    const actionId = actionIdOf(index, edge.from);
    if (actionId === null) continue;
    rows.push({
      optionId: edge.optionId,
      ordinal: edge.ordinal,
      actionId,
      actionPath: edge.from,
      actionLabel: index.byPath.get(edge.from)?.label?.label ?? actionId,
    });
  }
  return rows;
}

// Les transitions OK/HOME qui désignent une Action. Les deux emplacements de
// chaque Écran sont parcourus — pas seulement celui que l'auteur regardait.
export function incomingTransitionsForAction(index, actionPath) {
  const rows = [];
  for (const edge of index.incoming.get(actionPath) ?? []) {
    const slot = TRANSITION_SLOT_BY_EDGE_KIND[edge.kind];
    if (!slot) continue;
    const stageUuid = stageUuidOf(index, edge.from);
    if (stageUuid === null) continue;
    rows.push({
      slot,
      stageUuid,
      stagePath: edge.from,
      stageLabel: index.byPath.get(edge.from)?.label?.label ?? stageUuid,
      selection: edge.selection ?? null,
    });
  }
  return rows;
}

// Une sélection survit-elle au retrait du rang `ordinal` ?
//
// Miroir exact d'`OptionSelection::after_option_removed` suivi du contrôle de
// bornes : `Fixed(k)` ne glisse **jamais** sur son voisin, `Random` survit tant
// qu'une option reste. Une sélection déjà hors bornes le reste, et elle exige
// donc une décision elle aussi.
export function selectionSurvivesRemoval(selection, ordinal, remaining) {
  if (!selection) return true;
  if (selection.kind === 'random') return remaining > 0;
  const index = selection.index;
  if (!Number.isInteger(index)) return false;
  if (index === ordinal) return false;
  const after = index > ordinal ? index - 1 : index;
  return after >= 0 && after < remaining;
}

function selectionSurvivesRemovals(selection, ordinals, total) {
  let current = selection;
  let count = total;
  for (const ordinal of [...ordinals].sort((a, b) => b - a)) {
    const remaining = count - 1;
    if (!selectionSurvivesRemoval(current, ordinal, remaining)) return false;
    if (current?.kind === 'fixed' && current.index > ordinal) {
      current = { ...current, index: current.index - 1 };
    }
    count = remaining;
  }
  return true;
}

// Les transitions que le retrait d'une occurrence priverait de destination.
// Leur sélection est retirée sans glisser vers une option voisine.
export function optionRemovalImpact(index, actionPath, ordinal) {
  const entry = index.byPath.get(actionPath);
  const options = entry?.node?.options ?? [];
  const remaining = Math.max(0, options.length - 1);
  const decisions = incomingTransitionsForAction(index, actionPath)
    .filter((row) => !selectionSurvivesRemoval(row.selection, ordinal, remaining));
  return { remaining, decisions, options };
}

// Ce qu'un retrait d'Écran touche : les occurrences entrantes, puis les
// transitions que leurs retraits priveraient d'une destination. La simulation
// suit l'ordre décroissant des rangs que le moteur applique réellement.
export function stageRemovalImpact(index, stagePath, resolutionByOptionId = {}) {
  const occurrences = incomingOptionsForStage(index, stagePath);
  const removalsByAction = new Map();
  for (const occurrence of occurrences) {
    const resolution = resolutionByOptionId[occurrence.optionId];
    if (resolution?.form !== 'remove') continue;
    const list = removalsByAction.get(occurrence.actionPath) ?? [];
    list.push(occurrence.ordinal);
    removalsByAction.set(occurrence.actionPath, list);
  }

  const decisions = [];
  for (const [actionPath, ordinals] of removalsByAction) {
    const entry = index.byPath.get(actionPath);
    const total = entry?.node?.options?.length ?? 0;
    const remaining = Math.max(0, total - ordinals.length);
    for (const row of incomingTransitionsForAction(index, actionPath)) {
      // Une transition ne demande qu'une décision, même si plusieurs retraits
      // la concernent : c'est une destination qu'elle perd, pas un retrait.
      const survives = selectionSurvivesRemovals(row.selection, ordinals, total);
      if (!survives) decisions.push({ ...row, actionPath, remaining });
    }
  }
  return { occurrences, decisions };
}

// Ce qu'un retrait d'Action demande : une décision par transition entrante.
// Chaque emplacement est nommé séparément — un Écran peut désigner la même
// Action par OK **et** par HOME, et ce sont deux décisions.
export function actionRemovalImpact(index, actionPath) {
  return { transitions: incomingTransitionsForAction(index, actionPath) };
}

// Le plan d'une **coupe** : tout ce qui survit et perdrait sa destination passe
// à `null`.
//
// C'est un choix d'auteur : couper se fait, et ce qui casse est
// signalé plutôt que négocié. Un nouveau raccord reste un geste distinct.
//
// Deux choses distinguent ce plan de N plans de retrait mis bout à bout.
//
// 1. Il ne décide que du sort des références **survivantes**. Une occurrence
//    portée par une Action que la même coupe emporte n'a rien à décider : elle
//    ne survit pas. C'est ce qui évite de casser la plomberie interne d'un
//    motif qu'on déplace d'un bloc.
// 2. Il part en **un** geste, donc en un seul pas d'annulation, et ne peut pas
//    laisser la moitié d'une sélection coupée.
export function subgraphRemovalPlan(index, paths) {
  if (!index || !Array.isArray(paths) || paths.length === 0) return null;
  const entries = paths
    .map((path) => index.byPath.get(path))
    .filter((entry) => entry && (entry.kind === STAGE_KIND || entry.kind === ACTION_KIND));
  if (entries.length === 0) return null;
  const cut = new Set(entries.map((entry) => entry.path));

  const stages = [];
  const actions = [];
  const options = [];
  const transitions = [];
  for (const entry of entries) {
    if (entry.kind === STAGE_KIND) {
      stages.push(entry.node.uuid);
      for (const occurrence of incomingOptionsForStage(index, entry.path)) {
        if (cut.has(occurrence.actionPath)) continue;
        options.push({
          actionId: occurrence.actionId,
          ordinal: occurrence.ordinal,
          resolution: optionResolution.null(),
        });
      }
    } else {
      actions.push(entry.node.id);
      for (const row of incomingTransitionsForAction(index, entry.path)) {
        if (cut.has(row.stagePath)) continue;
        transitions.push({
          stageUuid: row.stageUuid,
          slot: row.slot,
          update: presence.null(),
        });
      }
    }
  }
  return { stages, actions, options, transitions };
}

// Ce que retirer une sélection ferait, pour la confirmation de retrait
// multiple : les nœuds qui partent, le décompte à annoncer, les raccords venus
// du reste du graphe qui resteront à reprendre, et le geste à envoyer. C'est le
// geste de Couper, sans le presse-papier. Il vaut `null` quand rien ne peut
// partir — l'Écran racine en tête, qui ne se retire pas.
export function selectionRemovalImpact(index, paths) {
  const entries = (paths ?? []).map((path) => index?.byPath.get(path)).filter(Boolean);
  const plan = subgraphRemovalPlan(index, entries.map((entry) => entry.path));
  const entryIncluded = entries.some((entry) => (
    entry.node?.squareOne?.presence === 'value' && entry.node.squareOne.value === true
  ));
  const stages = entries.filter((entry) => entry.kind === STAGE_KIND).length;
  const actions = entries.length - stages;
  return {
    entries,
    entryIncluded,
    loose: plan ? plan.options.length + plan.transitions.length : 0,
    counted: [
      stages > 0 ? `${stages} Écran${stages > 1 ? 's' : ''}` : null,
      actions > 0 ? `${actions} liste${actions > 1 ? 's' : ''} de choix` : null,
    ].filter(Boolean).join(' et '),
    gesture: plan && !entryIncluded ? advancedGestures.deleteSubgraph(plan) : null,
  };
}

// L'inventaire d'un refus, relu contre la vue courante.
//
// Les `references` d'un `GestureError` sont des chemins d'auteur. On les
// retrouve dans l'index par comparaison exacte ; celles qu'on n'y retrouve pas
// sont conservées telles quelles, pour être montrées plutôt qu'escamotées.
export function describeReferences(index, references = []) {
  const optionsById = new Map();
  // Un refus peut arriver **avant** que la vue soit lue — au premier geste d'une
  // session, ou quand la lecture a échoué. Sans index, aucune référence n'est
  // nommable : elles ressortent alors telles quelles, non résolues. C'est la
  // vérité de ce moment-là, et c'est en tout cas mieux qu'un plantage de
  // l'espace de travail au moment où il doit expliquer un refus.
  for (const entry of index?.entries ?? []) {
    if (entry.kind !== ACTION_KIND) continue;
    for (const option of entry.node.options ?? []) {
      optionsById.set(option.optionId, {
        optionId: option.optionId,
        ordinal: option.ordinal,
        actionId: entry.node.id,
        actionPath: entry.path,
        actionLabel: entry.label.label,
      });
    }
  }
  return references.map((reference) => optionsById.get(reference)
    ?? { optionId: null, path: reference, unresolved: true });
}

// La roue résultante, telle que l'auteur la verra après le retrait : c'est dans
// **celle-là** que `optionIndex` s'exprime (`0 ≤ i < N-1`), et la nommer évite
// qu'une interface propose un rang de la roue d'avant.
export function remainingOptionsAfterRemoval(options, ordinal) {
  return (options ?? [])
    .filter((_, rank) => rank !== ordinal)
    .map((option, rank) => ({ ...option, remainingIndex: rank }));
}
