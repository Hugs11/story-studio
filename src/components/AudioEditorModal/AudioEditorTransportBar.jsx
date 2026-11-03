import { Button } from '../common/Button';
import { Tooltip } from '../common/Tooltip';
import { Play, Pause, Square, SkipBack, SkipForward, Scissors, Crop } from '../icons/LucideLocal';
import { formatTime } from './audioEditorConstants';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';

// Barre de transport de l'éditeur audio : chips de fondu entrée/sortie,
// marqueurs de sélection, lecture, navigation et actions garder/supprimer.
export function AudioEditorTransportBar({
  fadeInSec,
  fadeOutSec,
  fadeMax,
  isApplying,
  isLoading,
  isPlaying,
  canOperate,
  canCut,
  onOpenFadePopover,
  onMarkStart,
  onMarkEnd,
  onPlayPause,
  onStop,
  onSkipBack,
  onSkipForward,
  onGoToTrimStart,
  onGoToTrimEnd,
  onStageTrim,
  onStageCut,
}) {
  const { t } = useMediaTranslation();
  return (
    <div className="audio-tb-row audio-editor-controls-row">
      <div className="audio-editor-fade-slot is-left">
        <Tooltip text={fadeInSec > 0 ? t('media:audioEditor.fade.inValue', { time: formatTime(Math.min(fadeInSec, fadeMax)) }) : t('media:audioEditor.fade.addIn')}>
          <Button
            variant="icon"
            className={`audio-tb-btn audio-editor-fade-chip${fadeInSec > 0 ? ' is-active' : ''}`}
            onClick={(e) => onOpenFadePopover('in', e)}
            onContextMenu={(e) => onOpenFadePopover('in', e)}
            disabled={isApplying}
          >
            ↗
          </Button>
        </Tooltip>
      </div>
      <div className="audio-tb">
        <Tooltip text={t('media:audioEditor.mark.start')}>
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={onMarkStart} disabled={isLoading}>{`{`}</Button>
        </Tooltip>
        <Tooltip text={t('media:audioEditor.mark.end')}>
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={onMarkEnd} disabled={isLoading}>{`}`}</Button>
        </Tooltip>

        <div className="audio-tb-sep" />

        <Tooltip text={isPlaying ? t('media:audioEditor.transport.pause') : t('media:audioEditor.transport.playPause')}>
          <Button variant="icon" className={`audio-tb-btn${isPlaying ? ' is-active' : ''}`} onClick={onPlayPause} disabled={isLoading}>
            {isPlaying ? <Pause /> : <Play />}
          </Button>
        </Tooltip>
        <Tooltip text={t('media:audioEditor.transport.stop')}>
          <Button variant="icon" className="audio-tb-btn" onClick={onStop} disabled={isLoading}><Square /></Button>
        </Tooltip>
        <Tooltip text={t('media:audioEditor.transport.back')}>
          <Button variant="icon" className="audio-tb-btn" onClick={onSkipBack} disabled={isLoading}><SkipBack /></Button>
        </Tooltip>
        <Tooltip text={t('media:audioEditor.transport.forward')}>
          <Button variant="icon" className="audio-tb-btn" onClick={onSkipForward} disabled={isLoading}><SkipForward /></Button>
        </Tooltip>

        <div className="audio-tb-sep" />

        <Tooltip text={t('media:audioEditor.goTo.start')}>
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={onGoToTrimStart} disabled={isLoading}>|▶</Button>
        </Tooltip>
        <Tooltip text={t('media:audioEditor.goTo.end')}>
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={onGoToTrimEnd} disabled={isLoading}>▶|</Button>
        </Tooltip>

        <div className="audio-tb-sep" />

        <Tooltip text={t('media:audioEditor.selection.keep')}>
          <Button
            variant="icon"
            className="audio-tb-btn"
            onClick={onStageTrim}
            disabled={!canOperate}
          >
            <Crop />
          </Button>
        </Tooltip>
        <Tooltip text={t('media:audioEditor.selection.cut')}>
          <Button
            variant="icon"
            className="audio-tb-btn audio-tb-btn-danger"
            onClick={onStageCut}
            disabled={!canCut}
          >
            <Scissors />
          </Button>
        </Tooltip>
      </div>
      <div className="audio-editor-fade-slot is-right">
        <Tooltip text={fadeOutSec > 0 ? t('media:audioEditor.fade.outValue', { time: formatTime(Math.min(fadeOutSec, fadeMax)) }) : t('media:audioEditor.fade.addOut')}>
          <Button
            variant="icon"
            className={`audio-tb-btn audio-editor-fade-chip${fadeOutSec > 0 ? ' is-active' : ''}`}
            onClick={(e) => onOpenFadePopover('out', e)}
            onContextMenu={(e) => onOpenFadePopover('out', e)}
            disabled={isApplying}
          >
            ↘
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
