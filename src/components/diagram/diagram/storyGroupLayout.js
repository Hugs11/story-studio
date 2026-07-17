// Prépare les groupes visuels d'un même parent dans le diagramme. Les dossiers
// sont placés avant les histoires afin que leurs barres structurelles restent
// dans un couloir libre au-dessus des vignettes.
export function orderDiagramChildren(children, isStructuralChild) {
  const structural = [];
  const content = [];

  for (const child of children) {
    if (isStructuralChild(child)) structural.push(child);
    else content.push(child);
  }

  return [...structural, ...content];
}

// Les histoires réparties sur plusieurs rangées deviennent un seul conteneur
// relié au parent : les liens individuels seraient visuellement trompeurs.
export function buildGroupedLayoutRows({ blocks, rowLimit, kind, groupIndex, groupSize, itemIds = [] }) {
  const chunks = [];
  for (let index = 0; index < blocks.length; index += rowLimit) {
    chunks.push(blocks.slice(index, index + rowLimit));
  }

  const isAggregateStoryGroup = kind === 'story' && chunks.length > 1;
  return chunks
    .filter((row) => row.length > 0)
    .map((row) => ({
      kind,
      groupIndex,
      groupSize,
      itemIds,
      isAggregateStoryGroup,
      blocks: row,
    }));
}
