/** Ancrages existants : fiche sous le bouton, filtres avec un écart de 8 px,
 * sélection au-dessus de la barre flottante (écart de 12 px). */
export function tagPopoverAt(trigger, ids, placement) {
  const rect = trigger.getBoundingClientRect();
  return { trigger, ...(ids === undefined ? {} : { targetIds: ids }),
    ...(placement === 'above' ? { placement } : {}),
    position: { x: rect.left, y: placement === 'above'
      ? trigger.closest('.catalogue-selection-floating').getBoundingClientRect().top - 12
      : rect.bottom + (placement === 'filter' ? 8 : 0) } };
}
