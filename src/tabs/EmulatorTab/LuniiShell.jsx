import { Tooltip } from '../../components/common/Tooltip';
import { formatPlaybackTime } from './navigationResolvers';
import '../EmulatorTab.css';

export function LuniiShell({
  image,
  title,
  sub,
  onOk,
  onHome,
  onLeft,
  onRight,
  paused,
  onPause,
  okDisabled,
  homeDisabled,
  playbackControls,
  chromeControls,
  onClose,
  dragHandleProps = null,
}) {
  return (
    <div className={`lunii-sim${chromeControls?.transparentPreview ? ' is-transparent-preview' : ''}`}>
      {(chromeControls || onClose) && (
        <div className="lunii-top-controls">
          <div className="lunii-top-controls-left">
            {dragHandleProps && (
              <Tooltip text="Déplacer le simulateur">
                <button
                  type="button"
                  className="lunii-drag-handle"
                  aria-label="Déplacer le simulateur"
                  {...dragHandleProps}
                >
                  ⋮⋮
                </button>
              </Tooltip>
            )}
            {chromeControls && (
              <>
                <Tooltip text={chromeControls.autoPlaybackEnabled ? "Désactiver les transitions automatiques dans le simulateur" : "Réactiver les transitions automatiques dans le simulateur"}>
                  <button
                    type="button"
                    className={`lunii-chip-btn${chromeControls.autoPlaybackEnabled ? ' is-active' : ''}`}
                    onClick={chromeControls.toggleAutoPlayback}
                  >
                    Auto
                  </button>
                </Tooltip>
                <Tooltip text={chromeControls.transparentPreview ? "Rendre l'aperçu opaque" : "Rendre l'aperçu transparent"}>
                  <button
                    type="button"
                    className={`lunii-chip-btn${chromeControls.transparentPreview ? ' is-active' : ''}`}
                    onClick={chromeControls.toggleTransparentPreview}
                  >
                    Transparence
                  </button>
                </Tooltip>
              </>
            )}
          </div>
          {onClose && (
            <button type="button" className="lunii-close-btn" onClick={onClose} aria-label="Fermer le simulateur">
              ×
            </button>
          )}
        </div>
      )}
      {playbackControls?.visible && (
        <div className="lunii-playback-bar">
          <Tooltip text="Reculer de 10 secondes">
            <button
              className="lunii-playback-jump"
              type="button"
              onClick={() => playbackControls.onSeek(playbackControls.currentTime - 10)}
            >
              -10s
            </button>
          </Tooltip>
          <span className="lunii-playback-time">{formatPlaybackTime(playbackControls.currentTime)}</span>
          <input
            className="lunii-playback-slider"
            type="range"
            min={0}
            max={Math.max(playbackControls.duration, 0)}
            step={0.1}
            value={Math.min(playbackControls.currentTime, playbackControls.duration || playbackControls.currentTime)}
            onChange={(event) => playbackControls.onSeek(Number(event.target.value))}
            disabled={playbackControls.duration <= 0}
          />
          <span className="lunii-playback-time">{formatPlaybackTime(playbackControls.duration)}</span>
          <Tooltip text="Avancer de 10 secondes">
            <button
              className="lunii-playback-jump"
              type="button"
              onClick={() => playbackControls.onSeek(playbackControls.currentTime + 10)}
            >
              +10s
            </button>
          </Tooltip>
        </div>
      )}
      <div className="lunii-body">
        <div className="lunii-wheel-zone">
          <div className="lunii-wheel" onClick={onOk}>
            <div className="lunii-wheel-left" onClick={e => { e.stopPropagation(); onLeft?.(); }} />
            <div className="lunii-wheel-right" onClick={e => { e.stopPropagation(); onRight?.(); }} />
          </div>
        </div>
        <div className="lunii-screen-zone">
          <div className="lunii-screen">
            {image}
            <div className="lunii-screen-text">
              <div className="lunii-screen-title">{title}</div>
              <div className="lunii-screen-sub">{sub}</div>
            </div>
          </div>
        </div>
        <div className="lunii-buttons">
          <Tooltip text="Accueil">
            <button className="lunii-btn-round" onClick={onHome} disabled={homeDisabled}>⌂</button>
          </Tooltip>
          <Tooltip text={paused ? 'Reprendre' : 'Pause'}>
            <button className="lunii-btn-round" onClick={onPause}>
              {paused ? '▶' : '⏸'}
            </button>
          </Tooltip>
          <Tooltip text="OK">
            <button className="lunii-btn-round lunii-btn-ok" onClick={onOk} disabled={okDisabled}>OK</button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
