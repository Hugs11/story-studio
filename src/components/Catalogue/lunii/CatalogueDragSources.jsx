import { memo, useMemo } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { CatalogueCard } from '../views/CatalogueCard.jsx';
import { CatalogueRow } from '../views/CatalogueRow.jsx';
import { sameCardProps } from '../../../store/catalogue/cardRenderMemo.js';

export const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="button"], [data-no-drag]';

/** Wraps a pointer-down activator so a press on an interactive child never starts a drag. */
export function ignoreInteractive(handler) {
  if (!handler) return handler;
  return event => {
    const target = event?.target;
    if (target?.closest?.(INTERACTIVE_SELECTOR)) return undefined;
    return handler(event);
  };
}

/**
 * Pointer-only drag source for a card or a list row. The keyboard path to the
 * panel stays the Send button, the selection bar and the menu: Space and
 * Enter belong to the item itself.
 */
function useCardSource(item) {
  const { card } = item;
  const title = card.displayTitle ?? card.title ?? '';
  const data = useMemo(() => ({ kind: 'card', cardId: card.id, title }), [card.id, title]);
  const { setNodeRef, listeners } = useDraggable({ id: `card:${card.id}`, data });
  const down = listeners?.onPointerDown;
  // Stable between drag moves: dnd-kit re-renders every draggable on each move, the memoized card must not follow.
  return useMemo(() => ({ ref: setNodeRef, onPointerDown: ignoreInteractive(down) }), [setNodeRef, down]);
}

const MemoCard = memo(CatalogueCard, sameCardProps);
const MemoRow = memo(CatalogueRow, sameCardProps);

export function DraggableCard(props) {
  return <MemoCard {...props} dragSource={useCardSource(props.item)} />;
}

export function DraggableRow(props) {
  return <MemoRow {...props} dragSource={useCardSource(props.item)} />;
}
