import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { sendCoverAddress } from '../../../store/catalogue/luniiSend.js';
import { Loader2, Speaker } from '../../icons/LucideLocal.jsx';
import { LuniiQueuedCancel } from './LuniiQueuedMark.jsx';

/**
 * A story whose send waits its turn: already at its drop place, greyed, with
 * no number (it is not on the Lunii yet). The cross cancels the whole send it
 * belongs to; a send that just started has no cross, the activity cancels it.
 */
export function LuniiQueuedRow({ story, onCancel }) {
  const { t } = useCatalogueTranslation();
  const cover = useDisplayableCover(sendCoverAddress(story));
  const title = story.title || t('catalogue:lunii.untitled');
  const cancelLabel = t('catalogue:lunii.queue.cancelSend', { count: story.count, title });
  return <div className={`lunii-story is-queued ${story.starting ? 'is-starting' : ''}`} role="row">
    <span role="gridcell" />
    <span role="gridcell" className="lunii-number" />
    <span role="gridcell" className="lunii-story-cell"><span className="lunii-story-select">
      <span className="lunii-cover">{cover ? <img src={cover} alt="" /> : <Speaker width={22} height={22} />}</span>
      <span className="lunii-story-text"><span>{title}</span>
        {story.starting
          ? <small className="lunii-sending-step"><Loader2 className="lunii-spinner lunii-step-spinner" width={12} height={12} aria-hidden="true" /><span>{t('catalogue:lunii.sendStep.preparing')}</span></small>
          : <small id={`lunii-queued-${story.key}`}>{t('catalogue:lunii.queue.sendWaiting')}</small>}</span>
    </span></span>
    <span role="gridcell" className="lunii-story-actions">{!story.starting && <LuniiQueuedCancel label={cancelLabel} describedBy={`lunii-queued-${story.key}`} onCancel={() => onCancel?.(story.entryId)} />}</span>
  </div>;
}
