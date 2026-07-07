import { useRef, useState, useEffect } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { useLocalFile } from '../../hooks/useLocalFile';
import { Button } from '../common/Button';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { RotateCcw } from '../icons/LucideLocal';
import { Tooltip } from '../common/Tooltip';
import { basename } from '../../utils/fileUtils';
import {
  NUDGE_STEP,
  SKIP_STEP,
  ZOOM_MIN,
  ZOOM_MAX,
  KEYBOARD_ZOOM_STEP,
  formatTime,
} from './audioEditorConstants';
import { createAudioEditorWaveformOptions, styleRegionHandles } from './audioEditorWaveform';
import { useAudioEditorShortcuts } from './useAudioEditorShortcuts';
import { useShuttlePlayback } from './useShuttlePlayback';
import { useWaveformViewport } from './useWaveformViewport';
import { useStagedAudioEdit } from './useStagedAudioEdit';
import { useFadeMenus } from './useFadeMenus';
import { AudioEditorTransportBar } from './AudioEditorTransportBar';
import { AudioEditorFadeOverlays } from './AudioEditorFadeOverlays';
import './AudioEditorModal.css';

export function AudioEditorModal({ filePath, savePath, workspaceDir, onConfirm, onCancel }) {
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);
  const durationRef = useRef(0);
  const isClampingRef = useRef(false);
  const trimStartRef = useRef(0);
  const trimEndRef = useRef(0);
  const auditionEndRef = useRef(null);

  const [duration, setDuration] = useState(0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const {
    shuttleRef,
    currentTime,
    setCurrentTime,
    isPlaying,
    setIsPlaying,
    shuttleStatus,
    clampAudioTime,
    setWaveTime,
    getCurrentAudioTime,
    stopShuttle,
    nudgeWithScrub,
    bumpShuttle,
    resetReverseBuffer,
  } = useShuttlePlayback({ wsRef, durationRef });

  const {
    zoom,
    setZoom,
    getWavePointer,
    zoomAtCurrentCursor,
    rememberWaveViewport,
    applyReadyViewport,
    handleWheel,
  } = useWaveformViewport({
    wsRef,
    durationRef,
    containerRef,
    getCurrentAudioTime,
    clampAudioTime,
    isLoading,
    onError: setError,
  });

  const {
    sourcePath,
    previewPath,
    discardPreviewPath,
    editInfo,
    stagedEdit,
    cutMarkers,
    fadeInSec,
    setFadeInSec,
    fadeOutSec,
    setFadeOutSec,
    cutFadeSec,
    setCutFadeSec,
    applyMode,
    isApplying,
    fadeMax,
    outputFadeMax,
    cutFadeMax,
    canValidate,
    initialEditRef,
    undoStagedEdit,
    regenerateFadePreview,
    handleRestoreOriginal,
    handleStageAction,
    handleApply,
  } = useStagedAudioEdit({
    filePath,
    savePath,
    workspaceDir,
    onConfirm,
    wsRef,
    durationRef,
    duration,
    trimStart,
    trimEnd,
    stopShuttle,
    rememberWaveViewport,
    setError,
  });

  const audioUrl = useLocalFile(previewPath || sourcePath || filePath);

  const {
    fadePopover,
    fadeContextMenu,
    currentFadeValue,
    fadeConfig,
    openFadePopover,
    openContextFadePopover,
    handleWaveformContextMenu,
    handleWaveformClick,
    setFadeValue,
    handleFadePopoverOk,
  } = useFadeMenus({
    fadeInSec,
    fadeOutSec,
    cutFadeSec,
    setFadeInSec,
    setFadeOutSec,
    setCutFadeSec,
    fadeMax,
    outputFadeMax,
    cutFadeMax,
    stagedEdit,
    previewPath,
    discardPreviewPath,
    regenerateFadePreview,
    stopShuttle,
    getWavePointer,
    durationRef,
    regionRef,
    trimStartRef,
    trimEndRef,
  });

  const filename = basename(filePath);
  const trimDuration = Math.max(0, trimEnd - trimStart);
  const canOperate = !isLoading && !isApplying && trimEnd > trimStart + 0.01;
  const canCut = canOperate && trimDuration < duration - 0.01;

  useEscapeKey(!isApplying, onCancel);

  // reason: ces 5 deps changent en pratique TOUJOURS EN GROUPE -- chaque
  // mutation de stagedEdit / cutMarkers / previewPath passe par
  // regenerateFadePreview ou handleStageAction qui appelle
  // invoke('preview_audio_edit', ...) -> setPreviewPath(newPath) -> audioUrl
  // change. Le re-decode audio est donc inherent au workflow (le user
  // bouge un fade -> ffmpeg regenere un preview -> waveform recharge).
  // Lot 11 P3 : analyse approfondie a montre que separer en 2 useEffects
  // coordonnes via wsReady ne procurerait aucun gain pratique. On garde
  // le pattern actuel ; la presence des 5 deps est une securite pour
  // les cas hypothetiques ou stagedEdit/cutMarkers changerait sans
  // changement audio.
  useEffect(() => {
    if (!audioUrl || !containerRef.current) return;

    let mounted = true;
    const wsRegions = RegionsPlugin.create();
    setIsLoading(true);
    setError(null);
    wsRef.current = null;
    resetReverseBuffer();

    const ws = WaveSurfer.create(createAudioEditorWaveformOptions({
      container: containerRef.current,
      url: audioUrl,
      plugins: [wsRegions],
    }));

    ws.on('ready', (dur) => {
      if (!mounted) return;
      wsRef.current = ws;
      const showingStagedPreview = !!previewPath && !!stagedEdit;
      const initial = initialEditRef.current ?? {};
      const initialStart = Math.max(0, Math.min(Number(initial.start ?? 0), dur));
      const initialEnd = Math.max(initialStart + 0.1, Math.min(Number(initial.end ?? dur), dur));
      durationRef.current = dur;
      setDuration(dur);

      applyReadyViewport(ws, dur, () => mounted && wsRef.current === ws);

      if (showingStagedPreview) {
        trimStartRef.current = 0;
        trimEndRef.current = parseFloat(dur.toFixed(3));
        setTrimStart(trimStartRef.current);
        setTrimEnd(trimEndRef.current);

        const previewSelection = wsRegions.addRegion({
          id: 'audio-selection-region',
          start: trimStartRef.current,
          end: trimEndRef.current,
          color: 'rgba(37, 99, 235, 0.2)',
          drag: false,
          resize: true,
        });
        styleRegionHandles(previewSelection, '#60a5fa');
        regionRef.current = previewSelection;

        const previewFadeMax = Math.max(0, Math.min(10, dur / 2));
        const stagedFadeIn = Math.min(Number(stagedEdit.fadeInSec ?? 0), previewFadeMax);
        const stagedFadeOut = Math.min(Number(stagedEdit.fadeOutSec ?? 0), previewFadeMax);
        if (stagedFadeIn > 0.01) {
          const fadeInRegion = wsRegions.addRegion({
            id: 'audio-fade-in-region',
            start: 0,
            end: Math.min(dur, stagedFadeIn),
            color: 'rgba(34, 197, 94, 0.28)',
            drag: false,
            resize: true,
            resizeStart: false,
            resizeEnd: true,
          });
          styleRegionHandles(fadeInRegion, '#4ade80');
        }
        if (stagedFadeOut > 0.01) {
          const fadeOutRegion = wsRegions.addRegion({
            id: 'audio-fade-out-region',
            start: Math.max(0, dur - stagedFadeOut),
            end: dur,
            color: 'rgba(34, 197, 94, 0.28)',
            drag: false,
            resize: true,
            resizeStart: true,
            resizeEnd: false,
          });
          styleRegionHandles(fadeOutRegion, '#4ade80');
        }
        const visibleCutMarkers = cutMarkers.length > 0
          ? cutMarkers
          : stagedEdit.mode === 'cut'
            ? [{ time: Number(stagedEdit.startSec ?? 0), fadeSec: Number(stagedEdit.cutFadeSec ?? 0) }]
            : [];
        visibleCutMarkers.forEach((marker) => {
          const join = Math.max(0, Math.min(Number(marker.time ?? 0), dur));
          const isCurrentCutMarker = stagedEdit.mode === 'cut'
            && Math.abs(join - Number(stagedEdit.startSec ?? -1)) < 0.02;
          const markerFadeMax = Math.max(0, Math.min(5, join));
          const fade = Math.min(Number(marker.fadeSec ?? 0), markerFadeMax);
          const markerStart = Math.max(0, join - Math.max(0.04, fade));
          const cutRegion = wsRegions.addRegion({
            id: isCurrentCutMarker ? 'audio-cut-region' : 'audio-cut-history-region',
            start: markerStart,
            end: Math.max(markerStart + 0.01, join),
            color: 'rgba(245, 158, 11, 0.5)',
            drag: false,
            resize: isCurrentCutMarker,
            resizeStart: true,
            resizeEnd: false,
          });
          styleRegionHandles(cutRegion, '#f59e0b');
        });
        setIsLoading(false);
        return;
      }

      trimStartRef.current = parseFloat(initialStart.toFixed(3));
      trimEndRef.current = parseFloat(initialEnd.toFixed(3));
      setTrimStart(trimStartRef.current);
      setTrimEnd(trimEndRef.current);

      const region = wsRegions.addRegion({
        id: 'audio-selection-region',
        start: trimStartRef.current,
        end: trimEndRef.current,
        color: 'rgba(37, 99, 235, 0.32)',
        drag: false,
        resize: true,
      });
      styleRegionHandles(region, '#60a5fa');
      regionRef.current = region;
      setIsLoading(false);
    });

    ws.on('error', () => {
      if (!mounted) return;
      if (wsRef.current === ws) wsRef.current = null;
      setIsLoading(false);
      setError('Impossible de charger le fichier audio.');
    });

    ws.on('play', () => { if (mounted) setIsPlaying(true); });
    ws.on('pause', () => {
      if (!mounted) return;
      setIsPlaying(false);
      if (auditionEndRef.current !== null) {
        auditionEndRef.current = null;
      }
    });
    ws.on('finish', () => {
      if (!mounted) return;
      setIsPlaying(false);
      auditionEndRef.current = null;
    });
    ws.on('timeupdate', (t) => {
      if (!mounted) return;
      const auditionEnd = auditionEndRef.current;
      if (auditionEnd !== null && t >= auditionEnd - 0.01) {
        auditionEndRef.current = null;
        ws.pause();
        ws.setTime(Math.min(auditionEnd, durationRef.current || auditionEnd));
        setCurrentTime(Math.min(auditionEnd, durationRef.current || auditionEnd));
        return;
      }
      setCurrentTime(t);
    });

    wsRegions.on('region-updated', (region) => {
      if (!mounted || isClampingRef.current) return;
      const dur = durationRef.current;
      let { start, end } = region;
      if (region.id === 'audio-fade-in-region') {
        const nextFade = parseFloat(Math.max(0, Math.min(end, dur / 2, 10)).toFixed(3));
        setFadeInSec(nextFade);
        void regenerateFadePreview({ fadeInSec: nextFade });
        return;
      }
      if (region.id === 'audio-fade-out-region') {
        const nextFade = parseFloat(Math.max(0, Math.min(dur - start, dur / 2, 10)).toFixed(3));
        setFadeOutSec(nextFade);
        void regenerateFadePreview({ fadeOutSec: nextFade });
        return;
      }
      if (region.id === 'audio-cut-region') {
        const nextFade = parseFloat(Math.max(0, Math.min(end - start, 5, end)).toFixed(3));
        const normalizedFade = nextFade <= 0.06 ? 0 : nextFade;
        setCutFadeSec(normalizedFade);
        void regenerateFadePreview({ cutFadeSec: normalizedFade }, 'cut');
        return;
      }
      if (region.id !== 'audio-selection-region') return;
      const cs = Math.max(0, Math.min(start, dur));
      const ce = Math.max(0, Math.min(end, dur));
      if (cs !== start || ce !== end) {
        isClampingRef.current = true;
        region.setOptions({ start: cs, end: ce });
        isClampingRef.current = false;
        start = cs;
        end = ce;
      }
      trimStartRef.current = start;
      trimEndRef.current = end;
      setTrimStart(parseFloat(start.toFixed(3)));
      setTrimEnd(parseFloat(end.toFixed(3)));
    });

    containerRef.current?.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      mounted = false;
      auditionEndRef.current = null;
      stopShuttle();
      containerRef.current?.removeEventListener('wheel', handleWheel);
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
      regionRef.current = null;
    };
  }, [audioUrl, sourcePath, previewPath, stagedEdit, cutMarkers]);

  useAudioEditorShortcuts({
    isLoading,
    canOperate,
    canCut,
    stagedEdit,
    previewPath,
    actions: {
      undo: undoStagedEdit,
      zoomIn: () => zoomAtCurrentCursor(KEYBOARD_ZOOM_STEP),
      zoomOut: () => zoomAtCurrentCursor(-KEYBOARD_ZOOM_STEP),
      clearStart: clearStartPoint,
      clearEnd: clearEndPoint,
      trimSelection: () => { void handleStageAction('trim'); },
      cutSelection: () => { void handleStageAction('cut'); },
      playPause: handlePlayPause,
      nudgeBack: () => nudgeWithScrub(-NUDGE_STEP),
      nudgeForward: () => nudgeWithScrub(NUDGE_STEP),
      goToStart: () => { stopShuttle(); setWaveTime(0); },
      goToEnd: () => { stopShuttle(); setWaveTime(durationRef.current); },
      shuttleBack: () => bumpShuttle(-1),
      shuttleStop: () => { stopShuttle(); wsRef.current?.pause(); setIsPlaying(false); },
      shuttleForward: () => bumpShuttle(1),
      markStart: markStartHere,
      markEnd: markEndHere,
      previewIn: goToTrimStart,
      previewOut: goToTrimEnd,
    },
  });

  function handlePlayPause() {
    if (shuttleRef.current) {
      stopShuttle();
      return;
    }
    wsRef.current?.playPause();
  }

  function stopPlayback() {
    auditionEndRef.current = null;
    stopShuttle();
    wsRef.current?.stop();
    setCurrentTime(0);
  }

  function previewSelectionRange(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const dur = durationRef.current || duration;
    const safeStart = Math.max(0, Math.min(start, dur));
    const safeEnd = Math.max(safeStart, Math.min(end, dur));
    stopShuttle();
    auditionEndRef.current = safeEnd;
    setWaveTime(safeStart);
    void wsRef.current?.play();
  }

  function previewCurrentSelection() {
    previewSelectionRange(trimStartRef.current, trimEndRef.current);
  }

  function markStartHere() {
    const region = regionRef.current;
    if (!region) return;
    const cur = getCurrentAudioTime();
    const next = parseFloat(Math.max(0, Math.min(cur, region.end - 0.1)).toFixed(3));
    trimStartRef.current = next;
    region.setOptions({ start: next });
    setTrimStart(next);
  }

  function clearStartPoint() {
    const region = regionRef.current;
    if (!region) return;
    trimStartRef.current = 0;
    region.setOptions({ start: 0 });
    setTrimStart(0);
  }

  function markEndHere() {
    const region = regionRef.current;
    if (!region) return;
    const cur = getCurrentAudioTime();
    const next = parseFloat(Math.max(region.start + 0.1, Math.min(cur, durationRef.current)).toFixed(3));
    trimEndRef.current = next;
    region.setOptions({ end: next });
    setTrimEnd(next);
  }

  function clearEndPoint() {
    const region = regionRef.current;
    if (!region) return;
    const end = parseFloat((durationRef.current || duration).toFixed(3));
    trimEndRef.current = end;
    region.setOptions({ end });
    setTrimEnd(end);
  }

  function goToTrimStart() {
    stopShuttle();
    setWaveTime(trimStartRef.current);
  }

  function goToTrimEnd() {
    stopShuttle();
    setWaveTime(trimEndRef.current);
  }

  return (
    <div className="modal-overlay" onClick={isApplying ? undefined : onCancel}>
      <div className="modal-box audio-editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Éditer l'audio — {filename}</span>
          <Button variant="icon" className="modal-close" onClick={onCancel} disabled={isApplying}>×</Button>
        </div>

        <div className="audio-editor-body">
          <div className="audio-editor-time-row">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(duration)}</span>
            {shuttleStatus && <span className="audio-editor-shuttle-status">{shuttleStatus}</span>}
          </div>

          {/* Waveform */}
          <div
            className="audio-editor-waveform-wrap"
            onClickCapture={handleWaveformClick}
            onContextMenu={handleWaveformContextMenu}
          >
            {isLoading && (
              <div className="audio-editor-loading">
                {audioUrl ? "Analyse de la forme d'onde…" : 'Chargement du fichier…'}
              </div>
            )}
            <div ref={containerRef} className="audio-editor-waveform" />
          </div>

          <AudioEditorTransportBar
            fadeInSec={fadeInSec}
            fadeOutSec={fadeOutSec}
            fadeMax={fadeMax}
            isApplying={isApplying}
            isLoading={isLoading}
            isPlaying={isPlaying}
            canOperate={canOperate}
            canCut={canCut}
            onOpenFadePopover={openFadePopover}
            onMarkStart={markStartHere}
            onMarkEnd={markEndHere}
            onPlayPause={handlePlayPause}
            onStop={stopPlayback}
            onSkipBack={() => { stopShuttle(); wsRef.current?.skip(-SKIP_STEP); }}
            onSkipForward={() => { stopShuttle(); wsRef.current?.skip(SKIP_STEP); }}
            onGoToTrimStart={goToTrimStart}
            onGoToTrimEnd={goToTrimEnd}
            onStageTrim={() => handleStageAction('trim')}
            onStageCut={() => handleStageAction('cut')}
          />

          {/* Zoom */}
          <div className="audio-editor-row audio-editor-zoom-row">
            <span className="audio-editor-label">Zoom</span>
            <input
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={5}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="audio-editor-zoom-slider"
              disabled={isLoading}
            />
            <span className="audio-editor-zoom-val">×{(zoom / 20).toFixed(1)}</span>
            <span className="audio-editor-hint">Ctrl+molette / +/- · ← → 50ms · Début/Fin</span>
          </div>

          <section className="audio-editor-selection">
            <div className="audio-editor-selection-stats">
              <span>Entrée <strong>{formatTime(trimStart)}</strong></span>
              <span>Sortie <strong>{formatTime(trimEnd)}</strong></span>
              <span>Durée <strong>{formatTime(trimDuration)}</strong></span>
            </div>
            <Button
              className="audio-editor-preview-btn"
              onClick={previewCurrentSelection}
              disabled={!canOperate || applyMode === 'preview'}
            >
              Prévisualiser l'extrait
            </Button>
          </section>

          {editInfo?.original_available && (
            <div className="audio-editor-restore-row">
              <Tooltip text="Restaurer le fichier avant édition">
                <Button size="sm" className="audio-editor-restore-btn" onClick={handleRestoreOriginal} disabled={isApplying}>
                  <RotateCcw />
                  Restaurer l'original
                </Button>
              </Tooltip>
            </div>
          )}

          {error && <div className="audio-editor-error">{error}</div>}
        </div>

        <div className="audio-editor-footer">
          <Button onClick={onCancel} disabled={isApplying}>Annuler</Button>
          <Tooltip text={canValidate ? 'Valider les modifications' : 'Aucune modification à valider'} placement="above">
            <Button variant="primary" onClick={handleApply} disabled={!canValidate}>
              {applyMode === 'trim' || applyMode === 'cut'
                ? 'Application…'
                : canValidate
                  ? 'Valider les modifications'
                  : 'Aucune modification'}
            </Button>
          </Tooltip>
        </div>

        <AudioEditorFadeOverlays
          fadeContextMenu={fadeContextMenu}
          fadePopover={fadePopover}
          currentFadeValue={currentFadeValue}
          fadeConfig={fadeConfig}
          onOpenContextFadePopover={openContextFadePopover}
          onSetFadeValue={setFadeValue}
          onPopoverOk={handleFadePopoverOk}
        />
      </div>
    </div>
  );
}
