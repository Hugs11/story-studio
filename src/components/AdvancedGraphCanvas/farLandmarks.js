// Les repères du régime éloigné, décidés **une fois** pour les deux surfaces
// qui les dessinent.
//
// La couche HTML et la capture de recette peignaient chacune leur version de la
// même règle : quel nœud porte un repère, de quelle sorte, et avec quel texte.
// Deux transcriptions de la même intention finissent par divergerprécisément là
// où la recette sert de preuve — et c'est déjà arrivé une fois, la capture
// peignant des noms que la feuille de style écrêtait. La règle vit donc ici, en
// pur, et les deux la lisent.
//
// Ce module ne mesure rien dans le document : il travaille sur le relevé de
// surimpressions que le moteur publie, en **pixels écran**, et ne fait que
// décider ce qui est écrit.

// Les quatre sortes de repère, dans leur ordre de priorité de lecture.
export const LANDMARK_KINDS = Object.freeze({
  ENTRY: 'entry',
  SELECTED: 'selected',
  HUB: 'hub',
});

// La sorte de repère d'un nœud, ou `null` s'il n'en porte aucun.
//
// « Inaccessible » reste volontairement dehors : sur un pack dont l'entrée est
// cassée il désignerait presque tout le graphe. Il est compté, filtrable et
// nommé dans la liste, et porté par la pastille de la carte au zoom de travail.
export function landmarkKind(node) {
  if (node.isEntry) return LANDMARK_KINDS.ENTRY;
  if (node.selected) return LANDMARK_KINDS.SELECTED;
  if (node.isHub) return LANDMARK_KINDS.HUB;
  return null;
}

// Mesure approchée d'un nom, en pixels écran.
//
// Elle n'a pas besoin d'être exacte : elle sert à décider si deux noms se
// gêneraient, et une largeur un peu généreuse écarte un nom de plus, ce qui est
// le bon côté de l'erreur. La mesurer vraiment demanderait une mise en page, et
// donc un navigateur — ce module doit rester éprouvable sans.
const NAME_CHAR_PX = 7.5;
const NAME_HEIGHT_PX = 16;
// L'écart entre le bord d'une marque et son nom.
const NAME_GAP_PX = 6;
const ENTRY_TAG_OFFSET_PX = 34;
// L'anneau de l'entrée, tel que la feuille de style le dessine.
const ENTRY_RING_PX = 56;
// Le rayon de la marque de chaque sorte, en pixels écran : le nom se pose au
// bord de la marque, pas au bord d'une marque plus petite.
const MARK_RADIUS_PX = Object.freeze({
  [LANDMARK_KINDS.ENTRY]: ENTRY_RING_PX / 2,
  [LANDMARK_KINDS.SELECTED]: 12,
  [LANDMARK_KINDS.HUB]: 5.5,
});

// Les places d'un nom autour de sa marque, dans l'ordre où elles sont
// essayées. Dessous d'abord, c'est la lecture attendue ; les autres ne servent
// que quand elle est prise.
const NAME_PLACEMENTS = Object.freeze(['below', 'above', 'right', 'left']);

function nameWidth(text) {
  return Math.max(1, String(text).length * NAME_CHAR_PX);
}

function nameBox(text, node, offset, placement = 'below') {
  const width = nameWidth(text);
  if (placement === 'above') {
    return { x: node.x - width / 2, y: node.y - offset - NAME_HEIGHT_PX, width, height: NAME_HEIGHT_PX };
  }
  if (placement === 'right') {
    return { x: node.x + offset, y: node.y - NAME_HEIGHT_PX / 2, width, height: NAME_HEIGHT_PX };
  }
  if (placement === 'left') {
    return { x: node.x - offset - width, y: node.y - NAME_HEIGHT_PX / 2, width, height: NAME_HEIGHT_PX };
  }
  return { x: node.x - width / 2, y: node.y + offset, width, height: NAME_HEIGHT_PX };
}

function markBox(mark) {
  const radius = MARK_RADIUS_PX[mark.kind] ?? 0;
  return {
    x: mark.node.x - radius, y: mark.node.y - radius, width: radius * 2, height: radius * 2,
  };
}

// Les étiquettes de carrefour rangées dans la marge du graphe.
//
// À 3 %, un pack réel tient dans une colonne étroite au milieu de la fenêtre :
// la structure est serrée, et un nom posé contre son point tombe sur la trame,
// sur la racine ou sur le point voisin. Le vide est autour. Chaque carrefour y
// reçoit une étiquette, reliée à son point par un trait.
const CALLOUT_GAP_PX = 36;
const CALLOUT_EDGE_PX = 12;
const CALLOUT_MIN_ROOM_PX = 120;
const CALLOUT_ROW_PX = NAME_HEIGHT_PX + 8;

// Les étiquettes se rangent du côté le plus proche de leur point, s'il reste
// assez de marge ; sinon de l'autre. Sur un même côté, elles suivent l'ordre
// vertical de leurs points et s'empilent sans se chevaucher : les traits ne se
// croisent pas. Sans marge d'aucun côté, rien n'est rangé et les noms
// reviennent contre leur point.
export function calloutLayout(marks, bounds, viewport) {
  if (!bounds || !viewport || marks.length === 0) return new Map();
  const room = {
    right: viewport.width - bounds.x2 - CALLOUT_GAP_PX - CALLOUT_EDGE_PX,
    left: bounds.x1 - CALLOUT_GAP_PX - CALLOUT_EDGE_PX,
  };
  const sides = ['right', 'left'].filter((side) => room[side] >= CALLOUT_MIN_ROOM_PX);
  if (sides.length === 0) return new Map();
  const middle = (bounds.x1 + bounds.x2) / 2;
  const bySide = { right: [], left: [] };
  for (const mark of marks) {
    const preferred = mark.node.x >= middle ? 'right' : 'left';
    bySide[sides.includes(preferred) ? preferred : sides[0]].push(mark);
  }

  const layout = new Map();
  const top = CALLOUT_EDGE_PX + CALLOUT_ROW_PX / 2;
  const bottom = viewport.height - CALLOUT_EDGE_PX - CALLOUT_ROW_PX / 2;
  for (const side of sides) {
    const column = bySide[side].sort((left, right) => (left.node.y - right.node.y)
      || String(left.node.path).localeCompare(String(right.node.path)));
    if (column.length === 0) continue;
    const rows = [];
    for (const mark of column) {
      const previous = rows.length > 0 ? rows[rows.length - 1] : -Infinity;
      rows.push(Math.max(mark.node.y, previous + CALLOUT_ROW_PX, top));
    }
    // Une pile qui déborde en bas remonte d'un bloc, sans repasser au-dessus
    // du bord haut.
    const overflow = rows[rows.length - 1] - bottom;
    const shift = overflow > 0 ? Math.min(overflow, rows[0] - top) : 0;
    const x = side === 'right' ? bounds.x2 + CALLOUT_GAP_PX : bounds.x1 - CALLOUT_GAP_PX;
    column.forEach((mark, position) => {
      layout.set(mark.node.path, {
        side, x, y: rows[position] - shift, maxWidth: room[side],
      });
    });
  }
  return layout;
}

function overlaps(one, two) {
  return one.x < two.x + two.width && two.x < one.x + one.width
    && one.y < two.y + two.height && two.y < one.y + one.height;
}

// Les marques à peindre, avec leur texte et sa place déjà tranchés.
//
// Trois règles, et elles viennent toutes d'une mesure dans Tauri :
//
// 1. **un avertissement ne porte pas de nom.** Chacun portait le sien : 508
//    paires de noms qui se recouvrent dès le profil p90 de 795 nœuds, 85 257
//    sur le maximum de 9 121. Un nom par défaut n'aide personne quand il en
//    faut cinq cents ; ce qui aide est de voir où ils se concentrent et combien
//    il y en a, ce que porte le compte d'une marque regroupée.
// 2. **un nom de carrefour se range dans la marge** quand il y en a une, relié
//    à son point par un trait (`calloutLayout`). Sinon, comme tout autre nom,
//    **il cherche sa place avant de céder** : il se pose sous sa marque,
//    sinon au-dessus, à droite, puis à gauche. Sur un pack réel, les grands
//    menus sont serrés contre la racine : posés dessous, tous leurs noms
//    tombaient sur l'étiquette RACINE et disparaissaient ensemble, alors que
//    la place à droite était vide.
// 3. **un nom ne couvre ni l'anneau de l'entrée ni la marque d'un autre
//    repère.** Quand aucune des quatre places n'est libre, il cède : le plus
//    relié se pose d'abord, et l'autre garde son point, que l'infobulle nomme
//    encore. L'ordre est stable — degré décroissant, puis chemin — pour que
//    deux lectures du même document donnent le même dessin.
export function farLandmarkMarks(nodes = [], { bounds = null, viewport = null } = {}) {
  const candidates = [];
  for (const node of nodes) {
    const kind = landmarkKind(node);
    if (kind === null) continue;
    candidates.push({ node, kind, count: node.clusterCount ?? 1 });
  }

  // L'entrée et la sélection posent leur texte d'abord : ce sont elles qui
  // situent la lecture, et elles ne cèdent à personne.
  const order = { [LANDMARK_KINDS.ENTRY]: 0, [LANDMARK_KINDS.SELECTED]: 1, [LANDMARK_KINDS.HUB]: 2 };
  const named = candidates
    .filter((mark) => mark.count === 1)
    .sort((left, right) => (order[left.kind] - order[right.kind])
      || ((right.node.degree ?? 0) - (left.node.degree ?? 0))
      || String(left.node.path).localeCompare(String(right.node.path)));

  // Les marques elles-mêmes sont réservées avant tout nom. L'anneau de
  // l'entrée en fait partie : sans lui, le nom d'un carrefour voisin se posait
  // en travers.
  const marks = candidates.map((mark) => ({ path: mark.node.path, box: markBox(mark) }));
  const hubLabel = (node) => `${node.label} · ${node.degree ?? 0} lien${(node.degree ?? 0) === 1 ? '' : 's'}`;
  const callouts = calloutLayout(
    named.filter((mark) => mark.kind === LANDMARK_KINDS.HUB
      && mark.node.label !== null && mark.node.label !== undefined && String(mark.node.label) !== ''),
    bounds,
    viewport,
  );
  const placed = [];
  const text = new Map();
  const free = (box, path) => !placed.some((other) => overlaps(box, other))
    && !marks.some((mark) => mark.path !== path && overlaps(box, mark.box));
  for (const mark of named) {
    if (mark.kind === LANDMARK_KINDS.ENTRY) {
      // L'étiquette de l'entrée est posée sous son anneau, et ne bouge pas.
      placed.push(markBox(mark));
      placed.push(nameBox('RACINE', mark.node, ENTRY_TAG_OFFSET_PX));
      text.set(mark.node.path, {
        label: 'RACINE', title: mark.node.label ?? 'RACINE', tag: true,
        placement: 'below', offset: ENTRY_TAG_OFFSET_PX,
      });
      continue;
    }
    const label = mark.kind === LANDMARK_KINDS.HUB ? hubLabel(mark.node) : mark.node.label;
    if (label === null || label === undefined || String(label) === '') continue;
    const callout = callouts.get(mark.node.path);
    if (callout) {
      text.set(mark.node.path, {
        label: String(label), title: String(label), tag: false, placement: 'callout', callout,
      });
      continue;
    }
    const offset = (MARK_RADIUS_PX[mark.kind] ?? 0) + NAME_GAP_PX;
    const placement = NAME_PLACEMENTS.find((candidate) => (
      free(nameBox(label, mark.node, offset, candidate), mark.node.path)
    ));
    if (placement === undefined) {
      text.set(mark.node.path, { label: null, title: String(label) });
      continue;
    }
    placed.push(nameBox(label, mark.node, offset, placement));
    text.set(mark.node.path, {
      label: String(label), title: String(label), tag: false, placement, offset,
    });
  }

  return candidates.map((mark) => {
    const written = text.get(mark.node.path) ?? null;
    return {
      ...mark,
      grouped: mark.count > 1,
      label: written?.label ?? null,
      // Ce que le survol dit toujours, même quand le nom n'a pas trouvé de
      // place : c'est lui qui nomme un point resté muet.
      title: written?.title ?? null,
      isTag: written?.tag === true,
      placement: written?.label ? written.placement : null,
      offset: written?.label ? (written.offset ?? null) : null,
      // L'étiquette rangée dans la marge et le point d'où part son trait.
      callout: written?.callout ?? null,
    };
  });
}
