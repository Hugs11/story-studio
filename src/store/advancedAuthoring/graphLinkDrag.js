import { REVEALED_HANDLE, revealedHandleOffset } from '../../components/AdvancedGraphCanvas/nodeOverlayMetrics.js';

// Les deux décisions prises à chaque image pendant qu'un raccord se tire.
//
// Elles vivent ici, en pur, parce qu'elles n'ont besoin de rien d'autre que de
// nombres : le relevé de surimpressions que le moteur publie déjà, et la
// position du pointeur. Les éprouver ne demande donc pas de navigateur, alors
// que le geste qu'elles servent, lui, en demande un.

// La cible sous le pointeur, ou `null` au-dessus du vide.
//
// Le criblage n'avait lieu qu'au relâchement : on lâchait à l'aveugle, sans
// savoir ce qu'on allait toucher. Il est désormais fait à chaque image — au
// plus une fois par image, et non une fois par événement de pointeur, qui
// arrive jusqu'à deux fois plus souvent.
//
// La **plus proche** l'emporte, et non la première rencontrée : l'ordre du
// document n'a aucun rapport avec ce que l'auteur vise, et deux cartes qui se
// recouvrent désignaient jusqu'ici celle que le document cite en premier.
//
// `reach` élargit la boîte, en pixels écran, du débord des prises : elles sont
// peintes aux deux tiers hors du contour, et la boîte nue les laissait donc
// tomber dans le vide. Relâcher sur la prise d'arrivée d'un Écran ne le
// désignait pas — le geste concluait au vide et proposait d'en créer un autre,
// alors que l'auteur visait précisément celui qui était là. Une tolérance
// **uniforme**, et non la boîte de la couche des prises : sur une Action
// fournie, le rail monte à 180 unités et volerait les dépôts de ses voisines.
// Deux tolérances qui se recouvrent se départagent par la distance, comme deux
// silhouettes qui se recouvrent.
//
// `handleHalf` est la demi-largeur, en pixels écran, de la zone de saisie d'un
// bouton de prise. La pastille n'est que le centre de ce bouton : le pointeur
// qui le touche est sur la prise même s'il est loin du contour — et très loin
// pour une Liste fournie, dont le rail dépasse la hauteur de la carte. Toucher
// une prise d'un nœud vise ce nœud, exactement comme toucher sa carte ; le
// cadre de la cible et le dépôt lisent cette seule règle. Les poignées révélées
// sous le seuil de zoom sont posées hors de la carte à une place et une taille
// fixes, que la couche HTML calcule par `revealedHandleOffset`.
export function linkDropCandidate(nodes, pointer, sourcePath, reach = 0, handleHalf = 0) {
  let best = null;
  let bestDistance = Infinity;
  for (const node of nodes) {
    if (node.path === sourcePath) continue;
    const dx = pointer.x - node.x;
    const dy = pointer.y - node.y;
    let distance = null;
    if (Math.abs(dx) <= (node.width / 2) + reach && Math.abs(dy) <= (node.height / 2) + reach) {
      distance = (dx * dx) + (dy * dy);
    }
    if (handleHalf > 0) {
      for (const port of node.ports ?? []) {
        // La prise d'arrivée n'a pas de bouton : seule sa pastille compte.
        if (port.role === 'arrival') continue;
        const centre = port.revealed ? revealedHandleOffset(node, port) : { x: port.dx, y: port.dy };
        const half = port.revealed ? REVEALED_HANDLE.SIZE / 2 : handleHalf;
        const px = dx - centre.x;
        const py = dy - centre.y;
        if (Math.abs(px) > half || Math.abs(py) > half) continue;
        // Le bouton touché prime sur une carte voisine qui le recouvre.
        distance = Math.min(distance ?? Infinity, (px * px) + (py * py));
      }
    }
    if (distance !== null && distance < bestDistance) {
      bestDistance = distance;
      best = node;
    }
  }
  return best;
}

// Bande, en pixels écran, dans laquelle le pointeur entraîne la caméra.
const AUTO_PAN_MARGIN_PX = 64;

// Vitesse maximale, en pixels par image. À soixante images par seconde, cela
// fait environ mille pixels par seconde : assez pour traverser une fenêtre en
// deux secondes, assez lent pour s'arrêter où l'on veut.
const AUTO_PAN_MAX_PX = 17;

// Le déplacement de caméra que réclame la position du pointeur.
//
// Sans lui, la portée du geste est celle de la fenêtre : pour raccorder deux
// nœuds éloignés il fallait dézoomer avant d'attraper la prise, donc viser une
// pastille de trois pixels. Le pointeur qui s'approche d'un bord tire la vue,
// et la vitesse croît avec l'enfoncement dans la bande — on frôle pour ajuster,
// on pousse pour traverser.
export function autoPanVelocity(pointer, size, {
  margin = AUTO_PAN_MARGIN_PX,
  max = AUTO_PAN_MAX_PX,
} = {}) {
  const axis = (position, extent) => {
    if (!(extent > 0) || !Number.isFinite(position)) return 0;
    // La bande ne peut pas manger plus du tiers de la fenêtre : sur une surface
    // étroite, deux bandes qui se rejoignent feraient défiler en permanence.
    const band = Math.min(margin, extent / 3);
    if (band <= 0) return 0;
    if (position < band) return (Math.min(band, band - position) / band) * max;
    if (position > extent - band) return -(Math.min(band, position - (extent - band)) / band) * max;
    return 0;
  };
  return {
    x: axis(pointer.x, size.width),
    y: axis(pointer.y, size.height),
  };
}
