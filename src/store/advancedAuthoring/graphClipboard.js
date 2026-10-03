// Le presse-papier du graphe avancé.
//
// **Rien n'est partagé avec l'éditeur libre, et ce n'est pas un oubli.**
// `useDiagramClipboard` et `useTreeClipboard` travaillent sur l'arbre du
// projet — des entrées `menu` / `story`, clonées par `deepCloneEntry`,
// retrouvées par identifiant. Le graphe avancé édite des Écrans et des Actions
// par gestes natifs, et n'ouvre jamais le payload. « Comme dans l'éditeur
// libre » décrit l'ergonomie visée, jamais l'implémentation.
//
// Ce que ce module range est une **description autonome** : ni uuid, ni chemin
// d'auteur, ni référence au document d'origine. Un uuid recopié désignerait le
// nœud modèle, et un motif collé se raccorderait à sa source au lieu de sa
// copie. Les raccords s'expriment donc par des **rangs dans la description**,
// ce que le geste natif `paste-subgraph` sait résoudre vers les nœuds qu'il
// vient lui-même de créer.
//
// **Les raccords qui sortent de la sélection sont perdus** : c'est un choix
// d'auteur, et c'est ce qui rend « copier un motif » utile — dupliquer une
// branche de trois Écrans et deux Actions garde sa forme sans traîner derrière
// elle des liens vers le modèle.
//
// Les positions sont relatives à une **ancre**, le coin haut-gauche de ce qui
// est copié. Le collage donne l'ancre, la forme suit. Une position se tient en
// coordonnées de graphe, jamais en pixels écran.

import { ACTION_KIND, STAGE_KIND } from '../advancedGraphView/graphViewModel.js';
import {
  ADVANCED_CONTROL_KEYS,
  ADVANCED_TRANSITION_SLOTS,
  RANDOM_OPTION_INDEX,
  advancedGestures,
} from '../projectModel/advancedGestures.js';
import { MEDIA_BINDING_RESOLVED, mediaBindingsByAssetRef } from '../projectModel/mediaBindings.js';
import { pathKey } from '../../utils/fileUtils.js';
import { boundAssetRefForPath, freeAssetRef } from './mediaDrop.js';

// Le champ de transition du DTO pour chaque emplacement du dialecte.
const TRANSITION_FIELD = Object.freeze({ ok: 'okTransition', home: 'homeTransition' });

function authoredText(field) {
  return field?.presence === 'value' && typeof field.value === 'string' ? field.value : null;
}

// Les cinq contrôles, **complets**.
//
// Qui crée un Écran doit fournir les cinq booléens, et Story Studio ne
// fabrique jamais d'objet partiel : un objet incomplet est une forme d'entrée
// admise à l'import, pas une chose qu'une création produit. Un Écran source aux
// contrôles partiels est donc collé complet, aux valeurs observées — c'est déjà
// ce que fait la création d'un Écran depuis l'en-tête, aux cinq valeurs à faux.
function completeControls(controls) {
  return Object.fromEntries(ADVANCED_CONTROL_KEYS.map(
    (key) => [key, controls?.[key]?.presence === 'value' && controls[key].value === true],
  ));
}

// Le média est **partagé, pas dupliqué** : le modèle référence les médias, il
// ne les possède pas. Dupliquer le fichier serait un coût pur, et hors de portée
// d'un geste qui ne touche pas au disque.
//
// La référence voyage **avec son fichier** : `assetRef` dérive du nom du
// fichier (`intro.mp3`), et un autre projet peut porter la même référence vers
// un tout autre fichier. C'est le fichier, pas le nom, qui dit au collage quelle
// liaison réutiliser — voir `pastedMedia`. Une référence sans liaison dans la
// source part sans chemin, comme un média manquant.
function sharedMedia(slot, bindings) {
  if (slot?.presence !== 'value' || !slot.assetRef) return null;
  const binding = bindings.get(slot.assetRef);
  const path = typeof binding?.path === 'string' && binding.path.trim() ? binding.path : null;
  return {
    assetRef: slot.assetRef,
    file: { path, present: path !== null && binding?.status === MEDIA_BINDING_RESOLVED },
  };
}

function layoutOf(node) {
  const { x, y } = node?.layout ?? {};
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

// L'ancre : le coin haut-gauche de ce qui est copié. Coller la ramène au point
// demandé, et la forme du motif suit sans être recalculée.
function anchorOf(nodes) {
  const points = nodes.map(layoutOf).filter(Boolean);
  if (points.length === 0) return { x: 0, y: 0 };
  return {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y)),
  };
}

// La sélection, rangée en description autonome. Rend `null` quand rien de
// copiable n'est visé : l'appelant n'a alors rien à écrire dans le presse-papier.
//
// `project` fournit les liaisons médias, pour que chaque référence copiée
// emporte le fichier qu'elle désigne.
export function describeGraphSelection(index, paths, project = null) {
  if (!index || !Array.isArray(paths) || paths.length === 0) return null;
  const entries = paths
    .map((path) => index.byPath.get(path))
    .filter((entry) => entry && (entry.kind === STAGE_KIND || entry.kind === ACTION_KIND));
  if (entries.length === 0) return null;

  const stageEntries = entries.filter((entry) => entry.kind === STAGE_KIND);
  const actionEntries = entries.filter((entry) => entry.kind === ACTION_KIND);
  // Les rangs sont pris sur les **chemins**, jetons opaques et uniques, et non
  // sur les identifiants : un identifiant dupliqué (`uniqueId: false`) reste
  // lisible et donc copiable, mais ne désignerait pas un rang sans ambiguïté.
  const stageRank = new Map(stageEntries.map((entry, rank) => [entry.path, rank]));
  const actionRank = new Map(actionEntries.map((entry, rank) => [entry.path, rank]));
  const anchor = anchorOf(entries.map((entry) => entry.node));
  const offsetOf = (node) => {
    const point = layoutOf(node);
    return point ? { x: point.x - anchor.x, y: point.y - anchor.y } : null;
  };

  const bindings = mediaBindingsByAssetRef(project);
  const stages = stageEntries.map(({ node }) => ({
    name: authoredText(node.name),
    controls: completeControls(node.controls),
    audio: sharedMedia(node.audio, bindings),
    image: sharedMedia(node.image, bindings),
    offset: offsetOf(node),
  }));

  const actions = actionEntries.map(({ node }) => ({
    name: authoredText(node.name),
    // Une occurrence qui sortait de la sélection garde son **rang** et perd sa
    // destination : le dialecte admet un rang réservé sans cible, et les rangs
    // suivants gardent ainsi leur place dans la roue.
    options: (node.options ?? []).map((option) => {
      const rank = stageRank.get(option.target?.stagePath);
      return rank === undefined ? { target: 'null' } : { target: 'stage', stage: rank };
    }),
    offset: offsetOf(node),
  }));

  const transitions = [];
  for (const [rank, { node }] of stageEntries.entries()) {
    for (const slot of ADVANCED_TRANSITION_SLOTS) {
      const transition = node[TRANSITION_FIELD[slot]];
      if (transition?.presence !== 'value') continue;
      const action = actionRank.get(transition.actionPath);
      if (action === undefined) continue;
      // Une sélection déjà hors bornes dans la source est laissée derrière :
      // le geste natif la refuserait, et un collage n'a pas à propager une
      // erreur bloquante que l'auteur n'a pas demandée.
      if (transition.withinBounds !== true) continue;
      const optionIndex = transition.selection?.kind === 'random'
        ? RANDOM_OPTION_INDEX
        : transition.selection?.index;
      if (!Number.isInteger(optionIndex)) continue;
      transitions.push({ stage: rank, slot, action, optionIndex });
    }
  }

  // L'ancre est rendue **à côté** de la description, jamais dedans : elle
  // décrit d'où le motif vient, quand la description dit seulement sa forme.
  // Seule la duplication s'en sert, pour reposer la copie près de son modèle.
  return { stages, actions, transitions, anchor };
}

// Les points qu'un collage occupera, dans l'ordre de la description.
//
// Ils servent à **réserver** les places avant que l'aller-retour par Rust ait
// reposé la vue : sans cela, deux collages enchaînés se poseraient au même
// endroit. Voir `nodePlacement.js`.
export function pasteLandingPoints(description, anchor) {
  if (!description || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return [];
  return [...description.stages, ...description.actions]
    .map((node) => node.offset)
    .filter(Boolean)
    .map((offset) => ({ x: anchor.x + offset.x, y: anchor.y + offset.y }));
}

// Le média d'un Écran collé, résolu contre le projet **cible**.
//
// Trois cas, dans cet ordre — la règle de partage du dépôt de média
// (`planStageMediaAssignment`), appliquée au fichier copié :
//
// 1. la cible porte la **même référence vers le même fichier** : on la
//    réutilise. C'est le collage dans le projet de la copie, inchangé ;
// 2. une autre référence de la cible porte **ce fichier** : on la partage ;
// 3. sinon, une **référence neuve** est liée au fichier. Un emplacement fourni
//    exige côté natif une référence libre (`ASSET_REF_ALREADY_BOUND`), d'où
//    `freeAssetRef`.
//
// `created` retient les liaisons neuves du même collage : deux Écrans qui
// partageaient un fichier le partagent encore une fois collés, et le second
// réutilise, sans emplacement, la liaison que le premier vient de créer.
function pastedMedia(media, project, created) {
  if (!media) return null;
  const { assetRef, file } = media;
  if (!file) return { assetRef };
  const key = file.path ? pathKey(file.path) : null;
  const same = mediaBindingsByAssetRef(project).get(assetRef);
  const samePath = typeof same?.path === 'string' && same.path.trim() ? pathKey(same.path) : null;
  if (same && samePath === key) return { assetRef };
  const shared = key ? boundAssetRefForPath(project, file.path) : null;
  if (shared) return { assetRef: shared };
  // Sans chemin, rien ne prouve que deux références désignent le même
  // fichier : chacune reçoit sa propre liaison manquante.
  const createdKey = key ?? `ref:${assetRef}`;
  const already = created.get(createdKey);
  if (already) return { assetRef: already };
  const fresh = freeAssetRef(project, file.path ?? assetRef, [...created.values()]);
  created.set(createdKey, fresh);
  return { assetRef: fresh, location: { path: file.path, present: file.present } };
}

// La description devenue geste. L'ancre est le point où poser le coin
// haut-gauche du motif ; sans elle, les nœuds naissent où la disposition les met.
// `project` est le projet **cible** : ses liaisons décident du sort de chaque
// média (voir `pastedMedia`).
export function pasteSubgraphGesture(description, anchor = null, project = null) {
  if (!description) return null;
  const placed = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y);
  const position = (offset) => (placed && offset
    ? { x: anchor.x + offset.x, y: anchor.y + offset.y }
    : null);
  const created = new Map();
  return advancedGestures.pasteSubgraph({
    stages: description.stages.map(({ offset, audio, image, ...stage }) => ({
      ...stage,
      audio: pastedMedia(audio, project, created),
      image: pastedMedia(image, project, created),
      position: position(offset),
    })),
    actions: description.actions.map(({ offset, ...action }) => ({
      ...action,
      position: position(offset),
    })),
    transitions: description.transitions,
  });
}

// Le presse-papier lui-même : un singleton de module, comme celui que le
// TreePanel et le diagramme Libre se partagent. Il survit au démontage du
// panneau, ce qu'un état React ne ferait pas, et c'est ce qu'un auteur attend
// d'une copie — elle ne s'évapore pas parce qu'on a fermé puis rouvert le graphe.
//
// Il survit aussi au changement de projet, comme celui du Libre : les médias
// voyagent avec leur fichier, et le collage les relie au projet cible au lieu
// de se fier au nom de leur référence.
const clipboard = { current: null };

export function writeGraphClipboard(description) {
  clipboard.current = description ?? null;
  return clipboard.current;
}

export function readGraphClipboard() {
  return clipboard.current;
}

export function clearGraphClipboard() {
  clipboard.current = null;
}
