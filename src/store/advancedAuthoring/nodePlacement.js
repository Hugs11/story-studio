// Où poser un nœud qu'on vient de créer, quand le point demandé est déjà pris.
//
// Créer dix Écrans depuis l'en-tête envoie dix fois le **même** point — le
// centre de la vue — et empilait dix cartes exactement au même endroit :
// indiscernables, et inattrapables puisque seule celle du dessus reçoit le
// pointeur. Le clic droit répété au même pixel a le même défaut.
//
// Le décalage est **diagonal**, comme des fenêtres empilées : la volée reste
// groupée là où l'auteur l'a demandée, et chaque carte garde sa prise.

// Le pas de la cascade, en unités de graphe.
//
// Il vaut la demi-silhouette d'un Écran plus celle d'une Action : c'est
// exactement l'écart auquel les deux cessent de se recouvrir. Deux Actions sont
// alors largement dégagées, deux Écrans se chevauchent encore un peu — assez
// pour qu'on voie qu'ils sont plusieurs, pas assez pour qu'on en perde un.
//
// Les valeurs viennent de `NODE_GEOMETRY` (`engineContract.js`), recopiées et
// non importées : ce contrat importe déjà `graphLinkDraft.js`, et le lire
// depuis ce module refermerait un cycle. Si la silhouette d'un nœud change, ces
// deux nombres sont à reprendre avec elle.
export const NODE_CASCADE_STEP_X = 78; // 52 (demi-Écran) + 26 (demi-Action)
export const NODE_CASCADE_STEP_Y = 66; // 40 (demi-Écran) + 26 (demi-Action)

// Ce qui compte comme « le même endroit », en unités de graphe.
//
// Il est **volontairement plus petit que le pas**, et c'est tout le sujet : ce
// qu'on corrige est l'empilement exact, pas le chevauchement. Un dégagement à
// la taille du pas ferait fuir un nœud déposé au clic droit dans une zone
// fournie — sur un pack de neuf mille nœuds, presque tout point y serait « pris
// » et la carte naîtrait loin de là où l'auteur a visé, ce qui est le défaut
// qu'on est venu réparer.
export const NODE_CASCADE_CLEARANCE = 24;

export function freeNodeSpot(entries, point, {
  reserved = [],
  stepX = NODE_CASCADE_STEP_X,
  stepY = NODE_CASCADE_STEP_Y,
  clearance = NODE_CASCADE_CLEARANCE,
  attempts = 64,
} = {}) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;

  // Les voisins sont relevés **une fois**, et seulement ceux que la cascade
  // peut atteindre : sur un pack de neuf mille nœuds, rebalayer la collection à
  // chaque cran coûterait plus cher que le geste lui-même.
  const reachX = (stepX * attempts) + clearance;
  const reachY = (stepY * attempts) + clearance;
  const near = [...reserved];
  for (const entry of entries ?? []) {
    const { x, y } = entry?.node?.layout ?? {};
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (Math.abs(x - point.x) > reachX || Math.abs(y - point.y) > reachY) continue;
    near.push({ x, y });
  }

  for (let rank = 0; rank <= attempts; rank += 1) {
    const candidate = { x: point.x + (stepX * rank), y: point.y + (stepY * rank) };
    const taken = near.some((node) => Math.abs(node.x - candidate.x) < clearance
      && Math.abs(node.y - candidate.y) < clearance);
    if (!taken) return candidate;
  }

  // Cascade saturée — il faudrait soixante-cinq nœuds posés sur sa diagonale.
  // Poser au point demandé vaut mieux que ne pas créer.
  return { x: point.x, y: point.y };
}

// Les places distribuées que l'index ne montre pas encore.
//
// Un geste de création fait un aller-retour par Rust avant que la vue soit
// relue. Un auteur qui enchaîne les créations va plus vite que ce trajet : sans
// cette mémoire, les deux premières cartes se poseraient au même endroit, et le
// défaut qu'on corrige reviendrait précisément dans le cas qui l'a fait naître.
//
// Elle se purge d'elle-même : une place dont un nœud occupe désormais le point
// est retirée, parce que l'index la porte maintenant. Rien à vider à la main,
// et aucune dérive au fil d'une longue session.
export function pruneReservedSpots(reserved, entries, { epsilon = 1 } = {}) {
  if (!reserved?.length) return [];
  const landed = [];
  for (const entry of entries ?? []) {
    const { x, y } = entry?.node?.layout ?? {};
    if (Number.isFinite(x) && Number.isFinite(y)) landed.push({ x, y });
  }
  return reserved.filter((spot) => !landed.some(
    (node) => Math.abs(node.x - spot.x) < epsilon && Math.abs(node.y - spot.y) < epsilon,
  ));
}

// Rendre les places d'un geste qui n'a posé aucun nœud — refusé, périmé,
// retenu par un export. `pruneReservedSpots` ne les purgerait jamais, puisque
// rien n'atterrira dessus. Chaque place rendue n'en retire qu'**une** : deux
// créations en vol peuvent avoir réservé le même point.
export function releaseReservedSpots(reserved, released) {
  const remaining = [...(reserved ?? [])];
  for (const spot of released ?? []) {
    const at = remaining.findIndex((one) => one.x === spot.x && one.y === spot.y);
    if (at >= 0) remaining.splice(at, 1);
  }
  return remaining;
}
