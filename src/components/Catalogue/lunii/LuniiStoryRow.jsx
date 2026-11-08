import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { bytesCell } from '../../../store/catalogue/detailsRow.js';
import { luniiStoryCover } from '../../../store/catalogue/luniiDeviceApi.js';
import { Pencil, Eye, EyeOff, Loader2, BadgeCheck, FileX, Speaker, Trash2 } from '../../icons/LucideLocal.jsx';
import { LuniiGrip } from './LuniiGrip.jsx';
import { Button } from '../../common/Button.jsx';
import { Tooltip } from '../../common/Tooltip.jsx';
import { removalPending } from '../../../store/catalogue/luniiQueueView.js';
import { LuniiQueuedCancel, queuedActionLabel } from './LuniiQueuedMark.jsx';

/** `queued`: gestures waiting their turn on this story (struck through while its removal waits). */
export function LuniiStoryRow({ story, selected, onSelect, disabledReason: refusal, device, gestures, dragging, insertion, queued = [], onCancelQueued }) {
  const { t, cell } = useCatalogueTranslation();
  const cover = useDisplayableCover(luniiStoryCover(story));
  const removing = removalPending(queued);
  // A story about to leave takes no other gesture: its cross cancels the removal first.
  const disabledReason = refusal || (removing ? t('catalogue:lunii.queue.removingReason') : null);
  const title = story.title || t('catalogue:lunii.untitled');
  return <div className={`lunii-story ${story.hidden ? 'is-hidden' : ''} ${story.orphan ? 'is-orphan' : ''} ${selected ? 'is-selected' : ''} ${removing ? 'is-removing' : ''}`} role="row" aria-selected={selected} aria-busy={device?.pendingKeys?.includes(story.key) || undefined} data-insertion={insertion || undefined} data-lunii-drop={story.orphan ? 'orphan' : 'row'} data-device-id={device?.id} data-row-key={story.orphan ? undefined : story.key}>
    <span role="gridcell"><LuniiGrip story={story} device={device} disabledReason={disabledReason} dragging={dragging} /></span>
    <span role="gridcell" className="lunii-number"><input className="lunii-checkbox" type="checkbox" checked={!!selected} aria-label={t('catalogue:lunii.selectStory', { title: story.title || t('catalogue:lunii.untitled') })} onChange={event => onSelect({ ctrlKey: true, shiftKey: event.shiftKey })} /><span>{story.position}</span></span>
    <span role="gridcell" className="lunii-story-cell"><button type="button" id={`lunii-story-${story.key}`} className="lunii-story-select" onClick={onSelect} aria-pressed={selected}>
      <span className="lunii-cover">{story.orphan && !story.complete ? <FileX width={22} height={22} /> : cover ? <img src={cover} alt="" /> : <Speaker width={22} height={22} />}</span>
      <span className="lunii-story-text"><span className={!story.title ? 'lunii-untitled' : undefined}>{story.title || t('catalogue:lunii.untitled')}</span>
        {story.orphan && story.duplicateOfListed ? <Tooltip text={t('catalogue:lunii.duplicateCopyHelp')} asChild wrap><small className="lunii-orphan-note">{t('catalogue:lunii.duplicateCopy', { size: cell(bytesCell(story.sizeBytes)) })}</small></Tooltip>
          : story.orphan ? <Tooltip text={t('catalogue:lunii.orphanHelp')} asChild wrap><small className="lunii-orphan-note">{(story.complete ? t('catalogue:lunii.orphan', { size: cell(bytesCell(story.sizeBytes)) }) : t('catalogue:lunii.incomplete', { size: cell(bytesCell(story.sizeBytes)) }))}</small></Tooltip>
          : story.hidden ? <small>{t('catalogue:lunii.hidden')}</small> : null}
        {story.kind === 'official' && <small className="catalogue-official-tag lunii-official"><BadgeCheck width={11} height={11} aria-hidden="true" />{t('catalogue:lunii.officialTag')}</small>}
        {queued.map(mark => <small key={mark.entryId} id={`lunii-queued-${mark.entryId}-${story.key}`} className="lunii-queued-note">{queuedActionLabel(t, mark.action)}</small>)}
      </span>
    </button></span>
    <span role="gridcell" className="lunii-story-actions">{queued.map(mark => <LuniiQueuedCancel key={mark.entryId} label={t('catalogue:lunii.queue.cancelGesture', { title })} describedBy={`lunii-queued-${mark.entryId}-${story.key}`} onCancel={() => onCancelQueued?.(mark.entryId)} />)}
      {story.orphan && story.duplicateOfListed ? null : story.orphan
      ? <Tooltip text={disabledReason || (story.complete ? t('catalogue:lunii.putBack') : t('catalogue:lunii.orphanHelp'))} wrap><Button variant="icon" size="sm" disabled={!!disabledReason || !story.complete} aria-disabled={!!disabledReason || !story.complete} onClick={() => gestures?.orphan(device, story)} aria-label={t('catalogue:lunii.putBack')}><Eye width={15} height={15} /></Button></Tooltip>
      : <Tooltip text={disabledReason || (story.hidden ? t('catalogue:lunii.showHelp') : t('catalogue:lunii.hideHelp'))} wrap><Button variant="icon" size="sm" disabled={!!disabledReason} aria-disabled={!!disabledReason} onClick={() => gestures?.hide(device, story)} aria-label={(story.hidden ? t('catalogue:lunii.show') : t('catalogue:lunii.hide'))}>{device?.pendingKeys?.includes(story.key) ? <Loader2 className="lunii-spinner" width={15} height={15} /> : story.hidden ? <EyeOff width={15} height={15} /> : <Eye width={15} height={15} />}</Button></Tooltip>}
      {!story.orphan && !story.title && <Tooltip text={t('catalogue:lunii.nameStoryAction')} asChild wrap><Button variant="icon" size="sm" className="lunii-story-name" onClick={onSelect} aria-label={t('catalogue:lunii.nameStoryAction')}><Pencil width={15} height={15} /></Button></Tooltip>}
      <Tooltip text={disabledReason || (story.orphan ? t('catalogue:lunii.delete') : t('catalogue:lunii.remove'))} wrap><Button variant="icon" size="sm" className="lunii-story-remove" disabled={!!disabledReason} aria-disabled={!!disabledReason} onClick={() => gestures?.remove(device, [story])} aria-label={story.orphan ? t('catalogue:lunii.delete') : t('catalogue:lunii.remove')}><Trash2 width={15} height={15} /></Button></Tooltip></span>
  </div>;
}
