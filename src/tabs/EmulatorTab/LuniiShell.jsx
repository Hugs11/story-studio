import { translateCommon as t } from '../../i18n/commonPresentation.js';
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
  pauseDisabled,
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
              <Tooltip text={t('common:simulator.window.move')}>
                <button
                  type="button"
                  className="lunii-drag-handle"
                  aria-label={t('common:simulator.window.move')}
                  {...dragHandleProps}
                >
                  ⋮⋮
                </button>
              </Tooltip>
            )}
            {chromeControls && (
              <>
                <Tooltip text={chromeControls.autoPlaybackEnabled ? t('common:simulator.auto.disable') : t('common:simulator.auto.enable')}>
                  <button
                    type="button"
                    className={`lunii-chip-btn${chromeControls.autoPlaybackEnabled ? ' is-active' : ''}`}
                    onClick={chromeControls.toggleAutoPlayback}
                  >{t('common:simulator.auto.label')}</button>
                </Tooltip>
                <Tooltip text={chromeControls.transparentPreview ? t('common:simulator.opacity.opaque') : t('common:simulator.opacity.transparent')}>
                  <button
                    type="button"
                    className={`lunii-chip-btn${chromeControls.transparentPreview ? ' is-active' : ''}`}
                    onClick={chromeControls.toggleTransparentPreview}
                  >{t('common:simulator.opacity.label')}</button>
                </Tooltip>
              </>
            )}
          </div>
          {onClose && (
            <button type="button" className="lunii-close-btn" onClick={onClose} aria-label={t('common:simulator.window.close')}>
              ×
            </button>
          )}
        </div>
      )}
      {playbackControls?.visible && (
        <div className="lunii-playback-bar">
          <Tooltip text={t('common:simulator.seek.backward')}>
            <button
              className="lunii-playback-jump"
              type="button"
              onClick={() => playbackControls.onSeek(playbackControls.currentTime - 10)}
            >{t('common:simulator.seek.backwardLabel')}</button>
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
          <Tooltip text={t('common:simulator.seek.forward')}>
            <button
              className="lunii-playback-jump"
              type="button"
              onClick={() => playbackControls.onSeek(playbackControls.currentTime + 10)}
            >{t('common:simulator.seek.forwardLabel')}</button>
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
          <button
            type="button"
            className="lunii-btn-round"
            aria-label={t('common:simulator.home.label')}
            onClick={onHome}
            disabled={homeDisabled}
          >
            ⌂
          </button>
          <button
            type="button"
            className="lunii-btn-round"
            aria-label={paused ? t('common:simulator.pause.resume') : t('common:simulator.pause.label')}
            onClick={onPause}
            disabled={pauseDisabled}
          >
            {paused ? '▶' : '⏸'}
          </button>
          <button
            type="button"
            className="lunii-btn-round lunii-btn-ok"
            onClick={onOk}
            disabled={okDisabled}
          >{t('common:simulator.ok.label')}</button>
        </div>
      </div>
    </div>
  );
}
