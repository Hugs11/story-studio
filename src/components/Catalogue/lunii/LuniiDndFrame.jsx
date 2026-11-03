import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { LuniiDragGhost } from './LuniiDragGhost.jsx';

/** Puts the overlay's corner just below the pointer (or at the handle for a keyboard drag). */
export function snapToPointer({ activatorEvent, activeNodeRect, transform }) {
  if (!activeNodeRect || !Number.isFinite(activatorEvent?.clientX)) return transform;
  return { ...transform, x: transform.x + activatorEvent.clientX - activeNodeRect.left + 14, y: transform.y + activatorEvent.clientY - activeNodeRect.top + 14 };
}
const MODIFIERS = [snapToPointer];

/**
 * The single DndContext of the catalogue screen: cards and story handles are
 * its draggables; the panel's drop surfaces are read by `useLuniiDnd`. Pointer
 * drags need a 5px move so a click still selects; keyboard drags start on a
 * focused story handle (Space or Enter).
 */
export function LuniiDndFrame({ dnd, send, cardsById, children }) {
  const { t } = useCatalogueTranslation();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor));
  const title = ({ active }) => active?.data?.current?.title || t('catalogue:lunii.untitled');
  const announcements = {
    onDragStart: event => t('catalogue:dnd.pickedUp', { title: title(event) }),
    onDragOver: () => undefined,
    onDragEnd: event => t('catalogue:dnd.dropped', { title: title(event) }),
    onDragCancel: event => t('catalogue:dnd.cancelled', { title: title(event) }),
  };
  return <DndContext sensors={sensors} autoScroll={false} {...dnd.handlers} accessibility={{ announcements, screenReaderInstructions: { draggable: t('catalogue:dnd.instructions') } }}>
    {children}
    <DragOverlay modifiers={MODIFIERS} dropAnimation={null} style={{ width: 'auto', height: 'auto', pointerEvents: 'none' }}>
      {dnd.active ? <LuniiDragGhost send={send} cardsById={cardsById} active={dnd.active} /> : null}
    </DragOverlay>
  </DndContext>;
}
