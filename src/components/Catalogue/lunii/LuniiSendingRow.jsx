import { useDisplayableCover } from '../../../hooks/useDisplayableCover.js';
import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';
import { ACTIVE_STEPS, sendCoverAddress, sendStepKey } from '../../../store/catalogue/luniiSend.js';
import { CircleCheck, Loader2, Speaker } from '../../icons/LucideLocal.jsx';

/** A story being copied: already at its place, with its step, before the list is read again. */
export function LuniiSendingRow({ story }) {
  const { t, line } = useCatalogueTranslation();
  const cover = useDisplayableCover(sendCoverAddress(story));
  const done = story.step === 'done';
  const active = ACTIVE_STEPS.includes(story.step);
  const stepLabel = line({ key: sendStepKey(story.step), params: { percent: story.progress } });
  return <div className={`lunii-story is-sending ${done ? 'is-sent' : ''}`} role="row" aria-busy={!done || undefined}>
    <span role="gridcell" />
    <span role="gridcell" className="lunii-number"><span>{story.position}</span></span>
    <span role="gridcell" className="lunii-story-cell"><span className="lunii-story-select">
      <span className="lunii-cover">{cover ? <img src={cover} alt="" /> : <Speaker width={22} height={22} />}</span>
      <span className="lunii-story-text"><span>{story.title || t('catalogue:lunii.untitled')}</span>
        <small className="lunii-sending-step">{active && <Loader2 className="lunii-spinner lunii-step-spinner" width={12} height={12} aria-hidden="true" />}<span>{stepLabel}</span></small></span>
    </span></span>
    <span role="gridcell" aria-label={done || active ? stepLabel : undefined}>{done && <CircleCheck className="lunii-sent-icon" width={15} height={15} />}</span>
    <span role="gridcell" />
  </div>;
}
