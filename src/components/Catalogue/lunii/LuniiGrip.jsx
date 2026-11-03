import { useDraggable } from '@dnd-kit/core';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { GripVertical } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

/** Reorder handle of a story row: pointer drag, or Space / Enter then arrows from the keyboard. */
export function LuniiGrip({ story, device, disabledReason, dragging }) {
  const { t } = useCatalogueTranslation();
  const disabled = Boolean(disabledReason) || Boolean(story.orphan);
  const { setNodeRef, attributes, listeners } = useDraggable({
    id: `lunii:${device.id}:${story.key}`,
    disabled,
    data: { kind: 'lunii-row', deviceId: device.id, key: story.key, title: story.title ?? '' },
    attributes: { roleDescription: t('catalogue:dnd.roleDescription') },
  });
  return <Tooltip text={disabledReason || t('catalogue:lunii.reorder')} wrap><Button ref={setNodeRef} variant="icon" size="sm" {...attributes} {...listeners} disabled={disabled} aria-pressed={dragging} aria-label={t('catalogue:lunii.reorder')}><GripVertical width={13} height={13} /></Button></Tooltip>;
}
