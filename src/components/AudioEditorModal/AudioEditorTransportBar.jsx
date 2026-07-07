import { Button } from '../common/Button';
import { Tooltip } from '../common/Tooltip';
import { Play, Pause, Square, SkipBack, SkipForward, Scissors, Crop } from '../icons/LucideLocal';
import { formatTime } from './audioEditorConstants';

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
  return (
    <div className="audio-tb-row audio-editor-controls-row">
      <div className="audio-editor-fade-slot is-left">
        <Tooltip text={fadeInSec > 0 ? `Fondu entrée ${formatTime(Math.min(fadeInSec, fadeMax))}` : 'Ajouter un fondu en entrée'}>
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
        <Tooltip text="Marquer le point d'entrée à la position du curseur (i)">
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={onMarkStart} disabled={isLoading}>{`{`}</Button>
        </Tooltip>
        <Tooltip text="Marquer le point de sortie à la position du curseur (o)">
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={onMarkEnd} disabled={isLoading}>{`}`}</Button>
        </Tooltip>

        <div className="audio-tb-sep" />

        <Tooltip text={isPlaying ? 'Pause (Espace)' : 'Play / Pause (Espace)'}>
          <Button variant="icon" className={`audio-tb-btn${isPlaying ? ' is-active' : ''}`} onClick={onPlayPause} disabled={isLoading}>
            {isPlaying ? <Pause /> : <Play />}
          </Button>
        </Tooltip>
        <Tooltip text="Stop">
          <Button variant="icon" className="audio-tb-btn" onClick={onStop} disabled={isLoading}><Square /></Button>
        </Tooltip>
        <Tooltip text="Reculer de 5s">
          <Button variant="icon" className="audio-tb-btn" onClick={onSkipBack} disabled={isLoading}><SkipBack /></Button>
        </Tooltip>
        <Tooltip text="Avancer de 5s">
          <Button variant="icon" className="audio-tb-btn" onClick={onSkipForward} disabled={isLoading}><SkipForward /></Button>
        </Tooltip>

        <div className="audio-tb-sep" />

        <Tooltip text="Aller au point d'entrée (Shift+I)">
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={onGoToTrimStart} disabled={isLoading}>|▶</Button>
        </Tooltip>
        <Tooltip text="Aller au point de sortie (Shift+O)">
          <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={onGoToTrimEnd} disabled={isLoading}>▶|</Button>
        </Tooltip>

        <div className="audio-tb-sep" />

        <Tooltip text="Garder la sélection (Ctrl+K)">
          <Button
            variant="icon"
            className="audio-tb-btn"
            onClick={onStageTrim}
            disabled={!canOperate}
          >
            <Crop />
          </Button>
        </Tooltip>
        <Tooltip text="Supprimer la sélection (Ctrl+X)">
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
        <Tooltip text={fadeOutSec > 0 ? `Fondu sortie ${formatTime(Math.min(fadeOutSec, fadeMax))}` : 'Ajouter un fondu en sortie'}>
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
