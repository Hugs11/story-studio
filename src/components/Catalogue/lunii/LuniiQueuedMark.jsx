import { X } from '../../icons/LucideLocal.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';

/** Visible name of a waiting gesture; `name` is the new Lunii name of a rename. */
export function queuedActionLabel(t, action, name = '') {
  switch (action) {
    case 'remove': return t('catalogue:lunii.queue.action.remove');
    case 'delete': return t('catalogue:lunii.queue.action.delete');
    case 'putBack': return t('catalogue:lunii.queue.action.putBack');
    case 'hide': return t('catalogue:lunii.queue.action.hide');
    case 'show': return t('catalogue:lunii.queue.action.show');
    case 'name': return t('catalogue:lunii.queue.action.name');
    case 'move': return t('catalogue:lunii.queue.action.move');
    case 'repatriate': return t('catalogue:lunii.queue.action.repatriate');
    case 'rename': return t('catalogue:lunii.queue.action.rename', { name });
    case 'repair': return t('catalogue:lunii.queue.action.repair');
    case 'restore': return t('catalogue:lunii.queue.action.restore');
    default: return t('catalogue:lunii.sendStep.pending');
  }
}

/**
 * The cross that takes one waiting entry out of the queue. Always visible (not
 * only on hover); `describedBy` names the element saying what would happen.
 */
export function LuniiQueuedCancel({ label, describedBy, onCancel }) {
  return <Tooltip text={label} asChild wrap><Button variant="icon" size="sm" className="lunii-queued-cancel" aria-label={label} aria-describedby={describedBy} onClick={onCancel}><X width={12} height={12} /></Button></Tooltip>;
}
