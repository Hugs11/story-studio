// La frontière étroite derrière laquelle vit le moteur d'affichage.
//
// Le DTO et la logique de recherche, de sélection et d'inspection ne
// connaissent **aucun** des deux moteurs. Sans cette frontière, le banc d'essai
// reviendrait à construire deux fois l'interface — et le verdict ne serait plus
// réversible.
//
// Ce fichier ne contient donc pas de code de rendu : il définit la forme
// neutre des éléments, le contrat que chaque adaptateur remplit, et la
// traduction DTO → éléments, qui est faite **une fois** pour tous les moteurs.

import { nodeLabel } from '../../../store/advancedGraphView/graphViewModel.js';
import { nodeRoles } from '../../../store/advancedGraphView/graphRoles.js';
import { GRAPH_LINK_PORTS, graphLinkPorts } from '../../../store/advancedAuthoring/graphLinkDraft.js';
import { defaultHomeReturns } from '../../../store/advancedGraphView/defaultHomeReturns.js';

// Les deux natures de nœud, rendues **distinctes**. Un adaptateur
// doit les distinguer autrement que par la seule couleur : forme, contour ou
// glyphe. La couleur seule ne suffit pas — elle n'est pas lisible pour tout le
// monde, et le canvas n'expose rien au DOM qui compenserait.
export const NODE_KINDS = Object.freeze({ STAGE: 'stage', ACTION: 'action' });

// Les trois natures d'arête. `stage-ok` et `stage-home` partent d'un Écran vers
// une Action ; `action-option` d'une Action vers un Écran. OK et HOME doivent
// être différenciés **autrement que par la couleur** : trait plein contre
// tireté, et une flèche distincte.
//
// `stage-home-default` est la quatrième, **dérivée** : le retour Accueil que la
// Lunii fait d'elle-même vers l'Écran d'entrée quand l'Écran n'enregistre
// aucune destination Accueil (`defaultHomeReturns.js`). Elle ne vient pas du
// DTO et n'est jamais écrite dans le document.
export const EDGE_KINDS = Object.freeze({
  STAGE_OK: 'stage-ok',
  STAGE_HOME: 'stage-home',
  STAGE_HOME_DEFAULT: 'stage-home-default',
  ACTION_OPTION: 'action-option',
});

// Familles filtrables de la légende. Le retour est reconnu avant la sélection
// aléatoire : cette dernière ne concerne que les options d'Action, alors qu'un
// retour reste un retour quel que soit le détail porté par la transition.
export const EDGE_VISIBILITY_GROUPS = Object.freeze({
  STRUCTURE: 'structure',
  RETURNS: 'returns',
  DEVICE_RETURNS: 'device-returns',
  RANDOM: 'random',
});

export const DEFAULT_EDGE_VISIBILITY = Object.freeze({
  [EDGE_VISIBILITY_GROUPS.STRUCTURE]: true,
  [EDGE_VISIBILITY_GROUPS.RETURNS]: true,
  [EDGE_VISIBILITY_GROUPS.DEVICE_RETURNS]: true,
  [EDGE_VISIBILITY_GROUPS.RANDOM]: true,
});

export function edgeVisibilityGroup(edge) {
  if (edge?.kind === EDGE_KINDS.STAGE_HOME_DEFAULT) return EDGE_VISIBILITY_GROUPS.DEVICE_RETURNS;
  if (edge?.kind === EDGE_KINDS.STAGE_HOME) return EDGE_VISIBILITY_GROUPS.RETURNS;
  if (edge?.selection?.kind === 'random' || edge?.random === true) {
    return EDGE_VISIBILITY_GROUPS.RANDOM;
  }
  return EDGE_VISIBILITY_GROUPS.STRUCTURE;
}

// Le contrat que chaque adaptateur remplit. Il est volontairement petit : tout
// ce qui peut vivre hors du moteur vit hors du moteur.
//
// ```
// createEngine({ container, onSelect, onViewportChange, onNodeDragEnd })
//   → {
//       name, version,
//       await mount(elements),          // pose le graphe complet
//       await setViewport({x, y, zoom}),
//       getViewport(),                  // → {x, y, zoom}, synchrone
//       await focusNode(path),          // → booléen ; cadre sans changer le zoom
//       forwardWheel(event),            // rejoue une molette reçue ailleurs → booléen
//       nodeAtPointer(),                // → chemin du nœud survolé, ou null
//       edgeAtPointer(),                // → identifiant du lien survolé, ou null
//       (aucune commande de rangement : les positions arrivent par le DTO)
//       setNodeImage(path, url),        // applique/retire la vignette locale
//       await setSelection(paths),
//       await setDetailLevel(level),    // full | noLabels | noThumbs | simplified
//       refreshTheme(),                 // relit la palette du thème courant
//       resize(),
//       await fitContent(),            // cadre tout le graphe, primitive du moteur
//       await exportImage(),            // → data URL PNG du rendu courant
//       destroy(),                      // doit tout rendre, y compris les écouteurs
//     }
// ```
//
// `exportImage` produit la preuve visuelle : le rendu **réel**, demandé
// au moteur qui l'a peint. C'est la seule capture qui ne dépende ni du
// gestionnaire de fenêtres, ni de ce qui se trouve à l'écran au même moment.
//
// `setViewport/getViewport` partagent la même convention : (x,y) est la
// position en pixels CSS de l'origine du graphe après zoom. Chaque adaptateur
// convertit vers sa caméra native. `fitContent` emploie sa primitive de cadrage
// pour inclure aussi les dimensions peintes des nœuds et des libellés.
//
// **Toutes les commandes sont attendues.** Ce n'est pas une précaution de
// style : `render`, `draw`, `zoomTo`, `translateTo`, `focusElement` et
// `setElementState` d'AntV G6 v5 rendent des promesses, tandis que leurs
// équivalents Cytoscape sont synchrones. Un banc qui n'attendrait pas
// mesurerait, pour l'un, du travail **déjà fait**, et pour l'autre du travail
// **pas encore commencé** — et donnerait au second une avance qu'il n'a pas.
// C'est exactement le genre d'écart qui rendrait le départage faux.
//
// `getViewport` reste synchrone : lire une caméra n'est une attente chez aucun
// des deux moteurs, et l'attendre ajouterait une micro-tâche dans la boucle de
// mesure des images par seconde.
//
// `nodeAtPointer` est synchrone pour la même raison, et il est **lu**, jamais
// calculé : chaque moteur tient déjà le nœud survolé par son propre criblage,
// et l'adaptateur ne fait que le rendre. Balayer les 9 121 nœuds à chaque
// mouvement de pointeur pour retrouver ce que le moteur sait déjà coûterait une
// passe complète par image pendant un glisser. C'est la porte par laquelle un
// média venu de la médiathèque trouve l'Écran sous le curseur : le canvas
// n'expose rien au DOM, donc `elementsFromPoint` — ce qu'emploient l'arbre et
// le diagramme Libre — n'y désigne jamais un nœud.
//
// `forwardWheel` existe parce que la couche HTML posée sur le canvas (repères,
// noms, prises) reçoit la molette à la place du moteur : le navigateur ne la lui
// remet pas. Le moteur rejoue donc l'événement chez lui, ce qui donne exactement
// le zoom, la sensibilité, les bornes et le centrage qu'il applique au-dessus
// du vide. Il rend `true` s'il l'a rejoué.
//
// `refreshTheme` existe parce qu'un adaptateur construit sa feuille de style
// **une fois**, au montage. Story Studio, lui, bascule clair/sombre à chaud :
// sans cette porte, le canvas gardait la palette de l'autre thème jusqu'au
// prochain remontage du document. Les deux témoins du banc portent une palette
// fixe, indépendante du thème ; chez eux la relecture n'a rien à changer, et
// leur méthode le dit.
//
// `destroy` est le point le plus sensible du banc d'essai : le protocole exige
// une destruction et une recréation du composant au changement de projet, et
// c'est là qu'une fuite se voit.
export const ENGINE_CONTRACT_METHODS = Object.freeze([
  'exportImage',
  'fitContent',
  'mount',
  'setViewport',
  'getViewport',
  'focusNode',
  'forwardWheel',
  'nodeAtPointer',
  'edgeAtPointer',
  'setNodeImage',
  'setSelection',
  'setPresentation',
  'setEdgeVisibility',
  'setDetailLevel',
  'refreshTheme',
  'resize',
  'destroy',
]);

export function assertEngineContract(engine) {
  const missing = ENGINE_CONTRACT_METHODS.filter((method) => typeof engine?.[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`Adaptateur incomplet : ${missing.join(', ')}`);
  }
  return engine;
}

// Traduction DTO → éléments neutres, faite **une fois** pour tous les moteurs.
//
// Deux occurrences d'option vers le même Écran produisent deux éléments d'arête
// distincts, avec deux identifiants distincts. Aucun adaptateur n'a le droit de
// les fusionner : c'est le critère d'élimination du banc d'essai.
export function toEngineElements(index) {
  // Les rôles sont calculés **une fois** par index, par le module que la
  // recherche, la liste et l'inspecteur lisent aussi. Un nœud marqué sur la
  // carte peinte est donc retrouvable par le filtre du même nom, avec la même
  // règle — ce qui n'était pas le cas tant que chaque surface refaisait son
  // propre comptage.
  const roles = nodeRoles(index);

  // Le comptage des options précède la construction des nœuds : la couche des
  // prises et les extrémités d'arête doivent lire **le même** nombre
  // d'emplacements. Une option pendante compte comme les autres — elle occupe
  // une place dans l'Action, et la taire ferait glisser toutes les suivantes.
  const optionCounts = new Map();
  for (const edge of index.view.edges ?? []) {
    if (edge.kind === EDGE_KINDS.ACTION_OPTION) {
      optionCounts.set(edge.from, (optionCounts.get(edge.from) ?? 0) + 1);
    }
  }
  const optionSlotsOf = (path) => (optionCounts.get(path) ?? 0) + 1;

  const nodes = index.entries.map((entry) => {
    const { label, isFallback } = entry.label ?? nodeLabel(entry.node);
    const role = roles.of(entry.path);
    return {
      id: entry.path,
      kind: entry.kind,
      label,
      // Un repli n'est pas un nom d'auteur : l'adaptateur peut le rendre en
      // retrait, il ne doit pas le rendre comme une valeur renseignée.
      labelIsFallback: isFallback,
      // Les positions sont reprises telles quelles. Un nœud sans position
      // d'auteur ni position d'éditeur en a déjà reçu une : le moteur natif
      // calcule à la lecture un placement de secours déterministe, en grille
      // et en bandes séparées, qu'il n'écrit jamais dans le document. Rien ne
      // reste donc à (0, 0), et aucune disposition automatique n'a à déplacer
      // ce que l'auteur a posé.
      x: entry.node.layout?.x ?? 0,
      y: entry.node.layout?.y ?? 0,
      // L'entrée est **repérée** : le protocole l'exige, et un graphe de 9 121
      // nœuds sans point d'entrée visible n'est pas navigable.
      isEntry: role.entry,
      // Un identifiant dupliqué n'est pas éditable par identifiant : le rendre
      // permet de le signaler sur le canvas comme dans l'inspecteur.
      duplicated: role.duplicate,
      diagnosed: role.diagnosed,
      incomingCount: role.incomingCount,
      outgoingCount: role.outgoingCount,
      degree: role.degree,
      isHub: role.hub,
      groupId: entry.node.groupId?.presence === 'value' ? entry.node.groupId.value : null,
      personalColor: entry.node.personalColor ?? null,
      linkPorts: graphLinkPorts(entry),
      // Emplacements du rail d'une Action : ses options **plus** la prise
      // d'ajout, qui occupe le dernier cran.
      optionSlots: entry.kind === NODE_KINDS.ACTION ? optionSlotsOf(entry.path) : 1,
      noIncoming: role.noIncoming,
      isolated: role.isolated,
      unreachable: role.unreachable,
      deadEnd: role.deadEnd,
      canvasLabel: entry.kind === NODE_KINDS.ACTION
        ? `${role.outgoingCount} sortie${role.outgoingCount === 1 ? '' : 's'}\n${label}`
        : label,
      imageAssetRef: entry.kind === NODE_KINDS.STAGE && entry.node.image?.presence === 'value'
        ? entry.node.image.assetRef
        : null,
    };
  });

  const kindByPath = new Map(nodes.map((node) => [node.id, node.kind]));
  const edges = (index.view.edges ?? []).map((edge) => ({
    id: edge.edgeId,
    kind: edge.kind,
    source: edge.from,
    target: edge.to,
    // Une arête pendante n'a pas de cible. Elle reste une information : la
    // taire ferait disparaître du canvas un défaut que l'auteur doit réparer.
    dangling: edge.dangling === true,
    ordinal: edge.ordinal,
    // Une sélection aléatoire ne désigne aucune occurrence : l'adaptateur ne
    // doit pas la rendre comme un choix figé.
    random: edge.selection?.kind === 'random',
    visibilityGroup: edgeVisibilityGroup(edge),
    // Un lien atterrit **sur la prise**, pas sur le contour : les deux lisent
    // la même géométrie, donc la flèche ne peut pas manquer sa pastille.
    sourceEndpoint: portEndpoint(sourcePortOffset(edge, optionSlotsOf(edge.from))),
    targetEndpoint: portEndpoint(arrivalPortOffset(kindByPath.get(edge.to))),
  }));

  // Les retours par défaut de la Lunii : partis de la prise Accueil de
  // l'Écran, ils arrivent sur l'Écran d'entrée.
  for (const derived of defaultHomeReturns(index)) {
    const edge = { kind: EDGE_KINDS.STAGE_HOME_DEFAULT };
    edges.push({
      id: derived.edgeId,
      kind: EDGE_KINDS.STAGE_HOME_DEFAULT,
      source: derived.from,
      target: derived.to,
      dangling: false,
      ordinal: 0,
      random: false,
      derived: true,
      visibilityGroup: edgeVisibilityGroup(edge),
      sourceEndpoint: portEndpoint(sourcePortOffset(edge, 1)),
      targetEndpoint: portEndpoint(arrivalPortOffset(NODE_KINDS.STAGE)),
    });
  }

  return { nodes, edges };
}

// La géométrie des prises, en unités de graphe **absolues** depuis le centre
// du nœud.
//
// Un seul point de vérité pour trois consommateurs : la pastille que le moteur
// peint, l'extrémité du lien qui y atterrit, et la zone de glisser que la
// couche HTML pose par-dessus. Les trois lisent les mêmes nombres ; aucun ne
// peut donc dériver des deux autres — et c'est exactement cette dérive qui
// avait fait échouer les essais de pastilles HTML, la couche HTML étant par
// construction une image en retard sur le canvas pendant un zoom.
//
// Les offsets sont absolus et non en pourcentage. Un endpoint Cytoscape en
// pourcentage est rapporté à `outerWidth`, bordure comprise, là où la
// décoration est calée sur la taille du nœud : les deux divergeaient déjà d'une
// demi-unité, et l'écart aurait grandi avec des prises sorties du contour.
// Cytoscape lit un offset sans unité comme des pixels de graphe et ne le rabat
// **pas** sur la silhouette — c'est ce qui autorise une prise hors contour.
export const NODE_GEOMETRY = Object.freeze({
  [NODE_KINDS.STAGE]: Object.freeze({ halfWidth: 52, halfHeight: 40 }),
  [NODE_KINDS.ACTION]: Object.freeze({ halfWidth: 26, halfHeight: 26 }),
});

export const PORT_RADIUS = 4.5;

// Une prise chevauche le contour : son centre est posé à un tiers de rayon
// dehors, donc les deux tiers du disque débordent. Elle cesse ainsi de couvrir
// la vignette qu'elle mordait auparavant, sans flotter détachée du nœud.
const PORT_STRADDLE = PORT_RADIUS / 3;

// De combien une prise déborde de la silhouette, en unités de graphe.
//
// Depuis que les prises sont sorties du contour, la silhouette nue ne décrit
// plus tout ce qui appartient visuellement au nœud : les deux tiers d'une
// pastille sont dehors. Un criblage de dépôt fait sur la seule silhouette
// manque donc la prise d'arrivée — on relâche sur elle en croyant viser le
// nœud, et le geste conclut au vide. C'est la même valeur qui borne ce défaut
// et qui place les pastilles, pour qu'elles ne puissent pas diverger.
export const PORT_OVERHANG = PORT_STRADDLE + PORT_RADIUS;

// Pas entre deux prises d'options : le diamètre, plus deux unités d'air. Il ne
// dépend **pas** du nombre d'options — c'est le rail qui s'allonge, jamais la
// pastille qui rétrécit. Les prises réparties sur la diagonale du losange
// tenaient 52/(N+1) unités, soit 4,7 pour dix sorties : le chevauchement était
// arithmétique, et le réduire en rétrécissant les pastilles les avait rendues
// invisibles.
const OPTION_PITCH = (PORT_RADIUS * 2) + 2;

// Course maximale du rail. Le pas de rangée du placement de secours est de 200
// unités : au-delà de cette course, une Action très fournie irait mordre la
// rangée voisine, et le pas se resserre plutôt que le rail ne déborde.
const OPTION_RAIL_SPAN = 180;

const PORT_IDS = Object.freeze({ ARRIVAL: 'arrival' });

// Le rôle d'une prise, tel que le **dessin** a besoin de le connaître. Il est
// distinct de son identifiant, qui appartient au vocabulaire de création : un
// adaptateur de rendu n'a pas à savoir ce qu'est un HOME, seulement qu'une
// prise se peint de telle façon. L'identifiant, lui, sert à rejoindre la liste
// fonctionnelle publiée par le modèle.
export const PORT_ROLES = Object.freeze({
  ARRIVAL: 'arrival',
  OK: 'ok',
  HOME: 'home',
  OPTION: 'option',
});

function optionPitch(slots) {
  return slots <= 1 ? 0 : Math.min(OPTION_PITCH, OPTION_RAIL_SPAN / (slots - 1));
}

// L'emplacement d'une option sur le rail. Les emplacements sont centrés sur le
// nœud, dans l'ordre des options ; le dernier est la prise d'ajout.
export function optionPortOffset(ordinal, slots) {
  const safeSlots = Math.max(1, slots);
  const safeOrdinal = Math.max(0, Math.min(safeSlots - 1, Number(ordinal) || 0));
  return {
    x: NODE_GEOMETRY[NODE_KINDS.ACTION].halfWidth + PORT_STRADDLE,
    y: (safeOrdinal - ((safeSlots - 1) / 2)) * optionPitch(safeSlots),
  };
}

// Toutes les prises d'un nœud, dans l'ordre de lecture. `optionSlots` compte
// les options existantes **plus** l'emplacement d'ajout.
export function nodePortOffsets(kind, optionSlots = 1) {
  if (kind === NODE_KINDS.ACTION) {
    const slots = Math.max(1, optionSlots);
    const ports = [{
      id: PORT_IDS.ARRIVAL,
      role: PORT_ROLES.ARRIVAL,
      ordinal: null,
      x: -(NODE_GEOMETRY[NODE_KINDS.ACTION].halfWidth + PORT_STRADDLE),
      y: 0,
    }];
    for (let ordinal = 0; ordinal < slots; ordinal += 1) {
      const { x, y } = optionPortOffset(ordinal, slots);
      ports.push({ id: GRAPH_LINK_PORTS.ACTION_OPTION, role: PORT_ROLES.OPTION, ordinal, x, y });
    }
    return ports;
  }
  const { halfWidth, halfHeight } = NODE_GEOMETRY[NODE_KINDS.STAGE];
  return [
    { id: PORT_IDS.ARRIVAL, role: PORT_ROLES.ARRIVAL, ordinal: null, x: -(halfWidth + PORT_STRADDLE), y: 0 },
    { id: GRAPH_LINK_PORTS.STAGE_OK, role: PORT_ROLES.OK, ordinal: null, x: halfWidth + PORT_STRADDLE, y: 0 },
    { id: GRAPH_LINK_PORTS.STAGE_HOME, role: PORT_ROLES.HOME, ordinal: null, x: 0, y: halfHeight + PORT_STRADDLE },
  ];
}

// La boîte que la couche des prises doit couvrir : centrée sur le nœud, assez
// large pour contenir la pastille la plus éloignée. Elle est portée par les
// attributs `width`/`height` du SVG lui-même, ce qui évite d'avoir à piloter
// `background-width` en données — une valeur mixte « auto puis nombre » sur un
// tableau de fonds est un piège inutile.
export function portLayerBox(kind, optionSlots = 1) {
  const geometry = NODE_GEOMETRY[kind] ?? NODE_GEOMETRY[NODE_KINDS.STAGE];
  let halfWidth = geometry.halfWidth;
  let halfHeight = geometry.halfHeight;
  for (const port of nodePortOffsets(kind, optionSlots)) {
    halfWidth = Math.max(halfWidth, Math.abs(port.x) + PORT_RADIUS);
    halfHeight = Math.max(halfHeight, Math.abs(port.y) + PORT_RADIUS);
  }
  return { width: Math.ceil(halfWidth) * 2, height: Math.ceil(halfHeight) * 2 };
}

// De combien la couche des prises déborde du nœud, par axe.
//
// Un moteur qui peint hors de la silhouette doit le **déclarer** : Cytoscape
// met en cache le rendu de chaque nœud dans une tuile dimensionnée sur sa boîte
// englobante, et tout ce qui dépasse y est rogné. Le défaut ne se voit pas
// pendant un mouvement de caméra — la scène est alors peinte d'un bloc, sans
// passer par ce cache — d'où des pastilles entières pendant le zoom et coupées
// à l'arrêt. `bounds-expansion` étend la boîte, donc la tuile.
//
// Le débord ne dépend que du nombre de crans, qui est fixe pour un nœud donné :
// il est calculé une fois au montage et ne suit pas le zoom. Une boîte
// englobante qui changerait de taille à chaque palier ferait recalculer les
// bornes de la scène pour rien.
export function portLayerOverflow(kind, optionSlots = 1) {
  const geometry = NODE_GEOMETRY[kind] ?? NODE_GEOMETRY[NODE_KINDS.STAGE];
  const box = portLayerBox(kind, optionSlots);
  return {
    x: Math.max(0, (box.width / 2) - geometry.halfWidth),
    y: Math.max(0, (box.height / 2) - geometry.halfHeight),
  };
}

// Un offset tel que Cytoscape le lit pour une extrémité d'arête.
function portEndpoint({ x, y }) {
  return `${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100}`;
}

function sourcePortOffset(edge, slots) {
  if (edge.kind === EDGE_KINDS.STAGE_HOME || edge.kind === EDGE_KINDS.STAGE_HOME_DEFAULT) {
    const { halfHeight } = NODE_GEOMETRY[NODE_KINDS.STAGE];
    return { x: 0, y: halfHeight + PORT_STRADDLE };
  }
  if (edge.kind === EDGE_KINDS.STAGE_OK) {
    const { halfWidth } = NODE_GEOMETRY[NODE_KINDS.STAGE];
    return { x: halfWidth + PORT_STRADDLE, y: 0 };
  }
  return optionPortOffset(edge.ordinal, slots);
}

function arrivalPortOffset(kind) {
  const geometry = NODE_GEOMETRY[kind] ?? NODE_GEOMETRY[NODE_KINDS.STAGE];
  return { x: -(geometry.halfWidth + PORT_STRADDLE), y: 0 };
}

// Les arêtes réellement posables par un moteur : celles qui ont une cible.
//
// Les moteurs refusent une arête vers un nœud inexistant, et certains lèvent.
// Les arêtes pendantes sont donc portées au canvas par une marque sur leur
// nœud source, pas par un lien vers le vide — mais elles **restent** dans le
// DTO, dans l'inspecteur et dans les diagnostics.
export function plottableEdges(elements) {
  return elements.edges.filter((edge) => edge.target !== null && edge.target !== undefined);
}

export function danglingSourcePaths(elements) {
  return new Set(
    elements.edges
      .filter((edge) => edge.dangling)
      .map((edge) => edge.source),
  );
}
