// À l'export, la disposition affichée devient la disposition d'auteur.
//
// Un nœud créé dans l'éditeur porte une position d'éditeur, et un nœud créé
// sans point désigné n'en porte aucune : le graphe les montre, mais le document
// ne les contient pas, et l'archive partait sans elles. Rouvert dans STUdio, le
// pack s'empilait ; rouvert par « Modifier un pack », il était rangé à neuf. Ce
// que l'auteur voit est ce qui part, et le projet garde ces positions comme les
// siennes.
//
// Ce module choisit **quoi** promouvoir, sans framework ni Tauri. La promotion
// passe par les deux gestes existants — `apply-view-layout`, puis
// `apply-layout-to-authoring` —, la seule porte admise vers les positions
// d'auteur.

import { SHORT_MAX, SHORT_MIN } from '../advancedGraphView/graphGeometry.js';
import { advancedGestures } from '../projectModel/advancedGestures.js';

function shortInteger(value) {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  return Math.min(SHORT_MAX, Math.max(SHORT_MIN, rounded));
}

// Les nœuds dont la position affichée n'est pas encore une position d'auteur,
// avec cette position en entiers du domaine d'auteur. Un nœud à identifiant
// dupliqué n'est adressable par aucun geste : il est laissé tel quel.
export function displayedLayoutToPromote(view) {
  const nodes = [
    ...(view?.stages ?? []).map((node) => ({ kind: 'stage', id: node.uuid, node })),
    ...(view?.actions ?? []).map((node) => ({ kind: 'action', id: node.id, node })),
  ];
  return nodes
    .filter(({ node }) => node.uniqueId !== false && node.layout && node.layout.source !== 'authored')
    .map(({ kind, id, node }) => ({
      node: { kind, id },
      position: { x: shortInteger(node.layout.x), y: shortInteger(node.layout.y) },
    }));
}

// Les gestes de la promotion, ou aucun s'il n'y a rien à promouvoir. La
// politique de bornes est `refuse` : les positions sont déjà ramenées dans le
// domaine, elle ne peut donc pas se déclencher.
export function displayedLayoutGestures(view) {
  const entries = displayedLayoutToPromote(view);
  if (entries.length === 0) return [];
  return [
    advancedGestures.applyViewLayout(entries),
    advancedGestures.applyLayoutToAuthoring(entries.map((entry) => entry.node), 'refuse'),
  ];
}

// La promotion complète, juste avant que l'export verrouille l'auteur.
//
// Rend le projet promu, ou `null` si rien n'a changé. L'appelant **doit**
// capturer ce projet-là : l'état de rendu ne le montre qu'au rendu suivant,
// et capturer l'ancien ferait partir l'archive sans les positions promues.
// Un échec ne bloque pas l'export — le pack part comme avant, et le journal le
// dit.
export async function promoteDisplayedLayout({
  readProject,
  readGraphView,
  runGesture,
  settle = async () => {},
  applied,
  warn = () => {},
}) {
  await settle();
  let gestures;
  try {
    gestures = displayedLayoutGestures(await readGraphView(readProject()));
  } catch (error) {
    warn(`lecture de la disposition impossible : ${String(error?.message ?? error)}`);
    return null;
  }
  let project = null;
  for (const gesture of gestures) {
    // Hors historique : l'affichage ne change pas, un Ctrl+Z n'aurait rien à
    // montrer.
    const outcome = await runGesture(gesture, { history: false });
    if (outcome?.status !== applied) {
      warn(`${gesture.gesture} non appliqué (${outcome?.status ?? 'inconnu'})`);
      return null;
    }
    project = outcome.project ?? project;
  }
  return project;
}
