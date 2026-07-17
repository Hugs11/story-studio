import { useCallback, useEffect } from 'react';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

export function PanelSortContext({ items, onMove, children }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const stopDragging = useCallback(() => {
    document.body.classList.remove('workspace-is-reordering');
  }, []);

  useEffect(() => stopDragging, [stopDragging]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={() => document.body.classList.add('workspace-is-reordering')}
      onDragCancel={stopDragging}
      onDragEnd={({ active, over }) => {
        stopDragging();
        if (!over || active.id === over.id) return;
        onMove?.(String(active.id), String(over.id));
      }}
    >
      <SortableContext items={items} strategy={horizontalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

export function SortablePanelItem({ id, className = '', activation = 'control', children }) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id });

  const headerPointerDown = useCallback((event) => {
    listeners?.onPointerDown?.(event);
  }, [listeners]);

  const dragHandleProps = activation === 'header'
    ? {
        ref: setActivatorNodeRef,
        onPointerDown: headerPointerDown,
        'data-panel-drag-handle': true,
      }
    : {
        ref: setActivatorNodeRef,
        ...attributes,
        ...listeners,
      };

  return (
    <div
      ref={setNodeRef}
      className={`${className}${isDragging ? ' is-panel-dragging' : ''}`}
      data-workspace-panel-id={id}
      style={{
        // Les panneaux ont volontairement des largeurs différentes. dnd-kit
        // ajoute un scale pour épouser le slot survolé ; seule la translation
        // est souhaitée ici afin que le panneau déplacé garde sa géométrie.
        transform: CSS.Translate.toString(transform),
        transition,
        zIndex: isDragging ? 20 : undefined,
      }}
    >
      {children({ dragHandleProps, isDragging })}
    </div>
  );
}
