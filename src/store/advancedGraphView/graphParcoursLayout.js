// La Vue parcours : ranger le graphe comme une histoire se lit.
//
// Ce module ne connaît **aucun moteur d'affichage**. Il rend des positions, et
// c'est tout ce qu'il rend. Cytoscape, G6 et vis-network les reçoivent par le
// même chemin que celles du DTO — le placement `preset` du montage —, donc un
// rangement calculé ici vaut pour les trois sans être écrit trois fois, et il
// s'éprouve sans monter d'interface.
//
// Il ne range pas le graphe du document : il range un **graphe de mise en
// page**, qui en diffère par trois transformations délibérées. C'est là
// qu'est toute la lisibilité, et les cinq dispositions génériques de la
// première passe échouaient précisément faute de les faire :
//
// 1. les retours Home ne comptent pas dans la hiérarchie. Sur un pack mesuré,
//    une Action de convergence recevait 28 arêtes entrantes dont 26 retours ;
//    toute mesure fondée sur le degré, sur des forces ou sur un choix de
//    racine automatique la plaçait donc au centre ou au sommet. Personne ne
//    lit une histoire en appuyant sur Home. Les retours restent **affichés** —
//    leur visibilité est un réglage indépendant — ils ne décident simplement
//    plus de rien ;
// 2. une Action qui n'appartient qu'à un seul Écran ne prend pas de rang à
//    elle : elle se pose à côté du sien. Une Action n'est pas une étape du
//    récit, c'est un raccord. Un pack mesuré comptait 26 Actions pour 37
//    Écrans, et leur donner un rang divisait par deux la densité de lecture.
//    C'est aussi ce qu'un auteur humain fait à la main : sur un pack de 862
//    nœuds positionnés dans STUdio, l'entrée, son Action et l'Écran suivant
//    tiennent sur une même ligne, à 265 puis 233 pixels d'écart ;
// 3. la racine est l'Écran d'entrée du pack, jamais le nœud le plus relié.
//
// Une Action **partagée** sort de la contraction et garde son rang propre : la
// convergence devient alors visible au lieu d'être subie. C'est la seule
// manière de respecter à la fois le dialecte — les deux natures de nœud restent
// distinctes — et la lecture : rester distinct et occuper un rang sont deux
// choses différentes.
//
// Tout est déterministe. Deux lectures du même document rendent les mêmes
// positions, à l'octet : aucune graine, aucune date, et chaque égalité est
// départagée par le chemin du nœud. C'est l'invariant que le reste de la vue
// avancée tient déjà, et un rangement qui bougerait d'une ouverture à l'autre
// ne serait pas utilisable comme position d'auteur.

import { STAGE_KIND } from './graphViewModel.js';
import { SHORT_MAX, SHORT_MIN } from './graphGeometry.js';

// Le retour Home, nommé ici comme `graphPresentation.js` le nomme déjà : la
// couche de vue ne dépend pas de la frontière des moteurs, qui dépend d'elle.
const STAGE_HOME = 'stage-home';

// Les pas, calibrés sur ce qu'un auteur a posé à la main et sur ce que la
// surface peint.
//
// L'histoire se lit **de la gauche vers la droite** : un rang est une colonne,
// pas une ligne. C'est l'orientation des positions STUdio mesurées, et celle
// que « graphe à plat » désigne. Les pas reprennent les écarts relevés sur ce
// pack. Le passage de l'Action de 104 à 52 de large retire 26 unités de chaque
// intervalle sans reprendre les pas inventés du handoff : les 161 unités d'air
// Écran→Action et les 131 unités Action→Écran restent donc intactes.
// `ROW` reste dominé par l'Écran de 80 de haut, son nom sur 14 posé 5 plus bas.
export const PARCOURS_STEPS = Object.freeze({
  LEVEL: 448,
  ACTION: 239,
  ROW: 200,
  // L'air entre deux composantes. Une histoire peut porter des nœuds
  // inaccessibles depuis l'entrée ; ils sont rangés **après**, et à distance,
  // pour qu'on voie du premier coup d'œil qu'ils ne tiennent pas au parcours.
  COMPONENT_GAP: 600,
});

// Les passes d'ordonnancement par barycentre. Deux avant, une arrière : au
// delà, le gain sur les croisements ne se voit plus et le coût, lui, reste.
const BARYCENTER_PASSES = 3;

/// L'Écran d'entrée, ou `null`. La racine n'est **jamais** devinée : sans
// entrée unique, le rangement se comporte comme un graphe sans racine et
// range chaque composante pour elle-même, plutôt que d'élire un nœud au
// hasard — ce que faisait « Par niveaux » et qui portait au sommet une Action
// de retour.
function rootStagePath(index) {
  const entry = index.view?.entry ?? null;
  if (entry?.status !== 'unique') return null;
  const path = entry.stagePath ?? null;
  return path && index.byPath.has(path) ? path : null;
}

// Les arêtes qui font avancer le récit : tout sauf un retour Home, et tout ce
// qui a une cible. Une arête pendante reste dans le DTO et sur le canvas ;
// elle ne mène simplement nulle part où placer quelque chose.
function progressionEdges(index) {
  return (index.view?.edges ?? []).filter(
    (edge) => edge.kind !== STAGE_HOME
      && edge.to !== null
      && edge.to !== undefined
      && index.byPath.has(edge.to)
      && index.byPath.has(edge.from),
  );
}

// Le graphe de mise en page : des unités, et les liens entre unités.
//
// Une unité est un Écran, éventuellement accompagné de l'Action qui n'est
// qu'à lui. Une Action partagée — ou orpheline — est une unité à elle seule.
export function buildLayoutGraph(index) {
  const edges = progressionEdges(index);

  // Combien d'Écrans mènent à chaque Action, retours Home exclus. C'est ce
  // comptage, et lui seul, qui distingue un raccord d'une convergence.
  const progressionIncoming = new Map();
  for (const edge of edges) {
    progressionIncoming.set(edge.to, (progressionIncoming.get(edge.to) ?? 0) + 1);
  }

  // Le propriétaire d'une Action privée. Une Action n'est adoptée que si
  // exactement un Écran y mène **et** que cet Écran ne porte pas déjà une
  // autre Action : un Écran n'a qu'un `okTransition`, mais le DTO est lu, pas
  // supposé, et deux occurrences d'un même identifiant existent.
  const ownerOf = new Map();
  const adopted = new Map();
  for (const edge of edges) {
    const target = index.byPath.get(edge.to);
    if (!target || target.kind === STAGE_KIND) continue;
    if (progressionIncoming.get(edge.to) !== 1) continue;
    const source = index.byPath.get(edge.from);
    if (!source || source.kind !== STAGE_KIND) continue;
    if (adopted.has(edge.from)) continue;
    adopted.set(edge.from, edge.to);
    ownerOf.set(edge.to, edge.from);
  }

  // Les unités, dans l'ordre stable des chemins : deux lectures du même
  // document énumèrent les mêmes unités dans le même ordre.
  const unitOf = new Map();
  const units = [];
  const paths = index.entries.map((entry) => entry.path).sort();
  for (const path of paths) {
    if (ownerOf.has(path)) continue;
    const unit = {
      id: units.length,
      anchor: path,
      // L'Action qui voyage avec l'Écran, ou `null`.
      satellite: adopted.get(path) ?? null,
      level: 0,
      row: 0,
      component: 0,
    };
    units.push(unit);
    unitOf.set(path, unit.id);
    if (unit.satellite) unitOf.set(unit.satellite, unit.id);
  }

  // Les liens entre unités. Un lien interne à une unité — l'Écran vers son
  // Action — a déjà été absorbé par la contraction et ne compte plus.
  const outgoing = units.map(() => new Set());
  const incoming = units.map(() => new Set());
  for (const edge of edges) {
    const from = unitOf.get(edge.from);
    const to = unitOf.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    outgoing[from].add(to);
    incoming[to].add(from);
  }

  return { units, unitOf, outgoing, incoming, ownerOf, edges };
}

// L'ordre dans lequel les composantes sont visitées.
//
// La composante de l'entrée passe toujours la première. Les autres sont
// abordées par leur nœud de plus petit chemin, pour que l'ordre ne dépende
// d'aucun parcours antérieur.
function componentRoots(graph, index, root) {
  const roots = [];
  if (root !== null) roots.push(graph.unitOf.get(root));
  const ordered = [...graph.units].sort((left, right) => left.anchor.localeCompare(right.anchor));
  // Un départ sans entrant se lit mieux qu'un départ pris au milieu d'un
  // cycle : les têtes de composante viennent donc avant le reste.
  for (const unit of ordered) {
    if (graph.incoming[unit.id].size === 0) roots.push(unit.id);
  }
  for (const unit of ordered) roots.push(unit.id);
  return roots;
}

// Affectation des rangs par parcours en largeur, composante par composante.
function assignLevels(graph, index, root) {
  const seen = new Set();
  const order = [];
  let component = 0;
  for (const start of componentRoots(graph, index, root)) {
    if (start === undefined || seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    graph.units[start].level = 0;
    graph.units[start].component = component;
    order.push(start);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      // Les successeurs sont triés par chemin : le parcours en largeur ne
      // doit rien devoir à l'ordre d'insertion d'un ensemble.
      const next = [...graph.outgoing[current]].sort(
        (left, right) => graph.units[left].anchor.localeCompare(graph.units[right].anchor),
      );
      for (const unit of next) {
        if (seen.has(unit)) continue;
        seen.add(unit);
        graph.units[unit].level = graph.units[current].level + 1;
        graph.units[unit].component = component;
        queue.push(unit);
        order.push(unit);
      }
    }
    component += 1;
  }
  return { order, components: component };
}

// Les unités rangées par composante puis par rang, dans l'ordre de découverte.
function levelsOf(graph, order, components) {
  const byComponent = [];
  for (let component = 0; component < components; component += 1) byComponent.push([]);
  for (const id of order) {
    const unit = graph.units[id];
    const levels = byComponent[unit.component];
    while (levels.length <= unit.level) levels.push([]);
    levels[unit.level].push(id);
  }
  return byComponent;
}

// Le barycentre d'une unité : la position moyenne de ses voisins dans le rang
// de référence. Une unité sans voisin garde sa place — la déplacer vers 0
// la ferait remonter en tête pour la seule raison qu'elle n'a rien à suivre.
function barycenter(ids, neighbours, rankOf, fallback) {
  const scores = new Map();
  ids.forEach((id, position) => {
    let total = 0;
    let count = 0;
    for (const neighbour of neighbours[id]) {
      const rank = rankOf.get(neighbour);
      if (rank === undefined) continue;
      total += rank;
      count += 1;
    }
    scores.set(id, count === 0 ? fallback(position) : total / count);
  });
  return scores;
}

// Ordonnancement par barycentre, en alternant les sens. C'est la réduction de
// croisements d'un layout par niveaux : chaque rang se réordonne vers la
// moyenne de ses voisins déjà placés, et l'opération converge vite.
function orderLevels(graph, levels) {
  for (let pass = 0; pass < BARYCENTER_PASSES; pass += 1) {
    const downward = pass % 2 === 0;
    const indices = levels.map((_, level) => level);
    if (!downward) indices.reverse();
    for (const level of indices) {
      // Le premier rang d'une passe descendante n'a pas de rang de référence.
      const reference = downward ? level - 1 : level + 1;
      if (reference < 0 || reference >= levels.length) continue;
      const rankOf = new Map();
      levels[reference].forEach((id, position) => rankOf.set(id, position));
      const neighbours = downward ? graph.incoming : graph.outgoing;
      const scores = barycenter(levels[level], neighbours, rankOf, (position) => position);
      // Le tri est **stable et total** : à barycentre égal, le chemin tranche.
      // Sans ce départage, deux lectures du même document pouvaient rendre
      // deux ordres, et donc deux jeux de positions.
      levels[level] = [...levels[level]].sort((left, right) => {
        const delta = scores.get(left) - scores.get(right);
        if (delta !== 0) return delta;
        return graph.units[left].anchor.localeCompare(graph.units[right].anchor);
      });
    }
  }
  return levels;
}

// Le repli, et pourquoi il est **demandé** et non deviné.
//
// Deux packs mesurés donnent les deux débordements possibles, et ce sont les
// deux faces d'un même fait — la forme du rangement est celle de l'histoire :
//
// - une histoire quasi linéaire tient sur 21 rangs de profondeur pour 6 de
//   large, soit 10 000 × 1 000 pixels : un fil de 10:1 ;
// - un gros pack construit en éventail tient sur 9 rangs dont un de 85 unités,
//   soit 4 000 × 16 800 pixels : une colonne de 1:4.
//
// Les deux sont des lectures **exactes**. Replier échange de la continuité
// contre de la compacité, et seul l'auteur sait ce qu'il cherche : suivre le
// fil de son histoire, ou en embrasser la forme d'un coup d'œil. Le rangement
// ne tranche donc pas à sa place — il expose les deux replis et n'en applique
// aucun par défaut.
//
// `bands` replie la suite des rangs en bandes empilées ; `lanes` replie les
// unités d'un même rang en colonnes voisines. Les deux sont indépendants,
// mais un seul axe déborde à la fois en pratique.
export const NO_FOLD = Object.freeze({ bands: 1, lanes: 1 });

// Le nombre de replis proposés : de 2 à 4 parts. Au delà, le repli hache la
// lecture plus qu'il ne la sert.
export const FOLD_PARTS = Object.freeze([2, 3, 4]);

function normalizeFold(fold) {
  const clamp = (value) => {
    const count = Math.trunc(Number(value));
    return Number.isFinite(count) && count > 1 ? Math.min(count, 4) : 1;
  };
  return { bands: clamp(fold?.bands), lanes: clamp(fold?.lanes) };
}

// La colonne et la ligne de chaque unité, avant conversion en pixels.
//
// Tout passe par une grille d'entiers : le repli n'est qu'une façon de
// remplir cette grille, et les pas en pixels restent les mêmes dans les
// quatre cas. C'est ce qui garde une Action collée à son Écran, un rang
// lisible et une disposition déterministe, replis compris.
function gridOf(levels, plan) {
  const cells = new Map();
  const perBand = Math.ceil(levels.length / plan.bands);
  let columns = 0;
  let rows = 0;
  // Chaque bande repart de la colonne 0 et descend d'une hauteur de bande.
  const bandTop = [];
  const bandRows = [];
  for (let band = 0; band < plan.bands; band += 1) {
    let tallest = 0;
    for (let level = band * perBand; level < Math.min((band + 1) * perBand, levels.length); level += 1) {
      const perLane = Math.ceil(levels[level].length / plan.lanes);
      tallest = Math.max(tallest, Math.min(levels[level].length, perLane));
    }
    bandRows.push(tallest);
  }
  let top = 0;
  for (const tallest of bandRows) {
    bandTop.push(top);
    // Une bande de plus doit se distinguer du rang suivant, sinon les deux se
    // confondent en une seule nappe.
    top += tallest + 2;
  }
  rows = top - 2;

  let column = 0;
  for (let band = 0; band < plan.bands; band += 1) {
    let widest = 0;
    for (let level = band * perBand; level < Math.min((band + 1) * perBand, levels.length); level += 1) {
      const ids = levels[level];
      const perLane = Math.max(1, Math.ceil(ids.length / plan.lanes));
      const lanes = Math.max(1, Math.ceil(ids.length / perLane));
      const localColumn = level - band * perBand;
      ids.forEach((id, index) => {
        const lane = Math.floor(index / perLane);
        const inLane = index % perLane;
        cells.set(id, {
          column: widest + lane,
          // Le rang est centré dans sa bande : une histoire qui s'ouvre en
          // éventail se lit mieux que la même accrochée en haut.
          row: bandTop[band] + inLane + (bandRows[band] - Math.min(ids.length, perLane)) / 2,
        });
      });
      widest += lanes;
      // `localColumn` n'est plus la colonne quand un rang en occupe
      // plusieurs : c'est `widest` qui avance, rang par rang.
      void localColumn;
    }
    column = Math.max(column, widest);
  }
  columns = column;
  return { cells, columns, rows };
}

// Une composante réduite à une seule unité, sans aucun lien : un nœud isolé.
function isLone(levels) {
  return levels.length === 1 && levels[0].length === 1;
}

// Les positions brutes, avant mise à l'échelle.
//
// Les nœuds isolés ne sont pas des histoires : donner à chacun l'air d'une
// composante (`COMPONENT_GAP`) les étirait en une colonne de plusieurs
// milliers d'unités, cartes illisibles. Ils sont donc rangés ensemble, après
// les composantes reliées, au pas d'une ligne comme des nœuds reliés ; seul le
// premier reste tenu à distance du reste. La composante de l'entrée (la
// première) garde sa place, et l'ordre des composantes reliées ne change pas.
function placeUnits(graph, byComponent, plan) {
  const positions = new Map();
  const [first, ...rest] = byComponent;
  const ordered = first === undefined
    ? []
    : [first, ...rest.filter((levels) => !isLone(levels)), ...rest.filter(isLone)];
  let offsetY = 0;
  for (const [position, levels] of ordered.entries()) {
    const { cells, rows } = gridOf(levels, plan);
    for (const [id, cell] of cells) {
      const unit = graph.units[id];
      const x = cell.column * PARCOURS_STEPS.LEVEL;
      const y = offsetY + cell.row * PARCOURS_STEPS.ROW;
      positions.set(unit.anchor, { x, y });
      // L'Action privée se pose à droite de son Écran, sur la même ligne :
      // c'est exactement l'intention mesurée sur les positions d'auteur.
      if (unit.satellite) {
        positions.set(unit.satellite, { x: x + PARCOURS_STEPS.ACTION, y });
      }
    }
    const next = ordered[position + 1];
    offsetY += isLone(levels) && next !== undefined && isLone(next)
      ? rows * PARCOURS_STEPS.ROW
      : (rows + 1) * PARCOURS_STEPS.ROW + PARCOURS_STEPS.COMPONENT_GAP;
  }
  return positions;
}

// L'étendue occupée, mesurée sur les positions rendues.
function extentOf(positions) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { x, y } of positions.values()) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Le recentrage et, si nécessaire, la mise à l'échelle dans `[-32768, 32767]`.
//
// C'est ce qui permet au rangement de devenir une position d'auteur **sans rien
// demander**. Story Studio ne crée pas une position hors borne sans décision
// explicite ; plutôt que de poser la question à l'auteur — ce que faisait le
// menu « politique pour les positions hors limite » —, le rangement se
// construit dans la borne. Un seul facteur pour tout l'ensemble : mettre à
// l'échelle nœud par nœud déplacerait les nœuds les uns par rapport aux autres,
// et ce sont leurs écarts qui portent la lecture.
function fitToAuthoredRange(positions) {
  const extent = extentOf(positions);
  if (!extent) return { positions, scale: 1 };
  const centerX = (extent.minX + extent.maxX) / 2;
  const centerY = (extent.minY + extent.maxY) / 2;
  const half = Math.min(Math.abs(SHORT_MIN), SHORT_MAX);
  const reach = Math.max(extent.width, extent.height) / 2;
  const scale = reach > half ? half / reach : 1;
  const fitted = new Map();
  for (const [path, { x, y }] of positions) {
    // L'arrondi est fait ici, une fois. Une position fractionnaire est valide
    // au sens du dialecte, mais le moteur natif la signale comme une fidélité
    // d'affichage réduite chez STUdio, et un rangement ne doit pas poser ce
    // défaut sur un document sain.
    fitted.set(path, {
      x: clamp(Math.round((x - centerX) * scale)),
      y: clamp(Math.round((y - centerY) * scale)),
    });
  }
  return { positions: fitted, scale };
}

function clamp(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < SHORT_MIN) return SHORT_MIN;
  if (value > SHORT_MAX) return SHORT_MAX;
  return value;
}

// Vrai quand un pack **importé** n'a aucune disposition lisible et doit être
// rangé à l'ouverture.
//
// Un projet créé dans l'éditeur n'est jamais rangé seul, quoi qu'il porte :
// ses nœuds créés sont posés comme dispositions d'éditeur, marquées comme
// celles d'une projection, et un auteur qui pose trois nœuds, enregistre puis
// rouvre les retrouverait tous déplacés.
//
// Deux formes de pack importé arrivent ainsi. Celles qui ne portent aucune position
// — un pack natif, un `story.json` à `position: null` — tombent sur le
// placement de secours ou le quadrillage de projection, qui ne suivent pas
// l'histoire. Et celles dont toutes les positions sont identiques : un pack
// relevé montre ses 431 nœuds tous posés en `{ x: 0, y: 0 }`, qui se
// peignaient empilés au même point. Une position n'est **placée** que si un
// auteur l'a posée ; une projection de lecture ne compte pas. Dès que deux
// nœuds placés diffèrent, le pack a une disposition et on n'y touche pas.
export function needsInitialLayout(index) {
  const origin = index?.view?.documentOrigin;
  if (origin !== 'imported-studio' && origin !== 'imported-fs') return false;
  const entries = index?.entries ?? [];
  if (entries.length < 2) return false;
  let first = null;
  for (const entry of entries) {
    const layout = entry.node?.layout;
    const placed = layout?.source === 'authored'
      || (layout?.source === 'editor-position' && layout.origin !== 'projection-derived');
    if (!placed) continue;
    if (first === null) first = layout;
    else if (layout.x !== first.x || layout.y !== first.y) return false;
  }
  return true;
}

// Le rangement complet : des positions pour **tous** les nœuds de l'index.
//
// Elles tiennent dans le domaine des positions d'auteur, sont entières, et ne
// dépendent que du document. Elles peuvent donc être peintes comme un aperçu
// puis écrites telles quelles, sans seconde décision.
export function parcoursLayout(index, fold = NO_FOLD) {
  if (!index || index.entries.length === 0) {
    return { positions: new Map(), scale: 1, root: null, shared: 0, contracted: 0, fold: NO_FOLD };
  }
  const plan = normalizeFold(fold);
  const root = rootStagePath(index);
  const graph = buildLayoutGraph(index);
  const { order, components } = assignLevels(graph, index, root);
  const byComponent = levelsOf(graph, order, components).map((levels) => orderLevels(graph, levels));
  const placed = placeUnits(graph, byComponent, plan);
  const { positions, scale } = fitToAuthoredRange(placed);
  const contracted = graph.units.filter((unit) => unit.satellite !== null).length;
  // Les Actions restées seules sont les convergences réelles du pack : une
  // unité dont l'ancre n'est pas un Écran. Le compte sert à l'expliquer dans
  // l'interface, jamais à décider d'un placement.
  const shared = graph.units.filter(
    (unit) => index.byPath.get(unit.anchor)?.kind !== STAGE_KIND,
  ).length;
  return { positions, scale, root, shared, contracted, units: graph.units.length, components, fold: plan };
}
