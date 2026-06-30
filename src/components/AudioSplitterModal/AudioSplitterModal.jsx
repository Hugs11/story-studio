import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { useLocalFile } from '../../hooks/useLocalFile';
import { useProjectContext } from '../../store/ProjectContext';
import { basename } from '../../utils/fileUtils';
import { Button } from '../common/Button';
import { Tooltip } from '../common/Tooltip';
import { Pause, Play, Scissors, SkipBack, SkipForward, Square, Trash2 } from '../icons/LucideLocal';
import {
  formatTime,
  KEYBOARD_ZOOM_STEP,
  NUDGE_STEP,
  SKIP_STEP,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../AudioEditorModal/audioEditorConstants';
import { useAudioEditorShortcuts } from '../AudioEditorModal/useAudioEditorShortcuts';
import { useShuttlePlayback } from '../AudioEditorModal/useShuttlePlayback';
import { createAudioEditorWaveformOptions, styleRegionHandles } from '../AudioEditorModal/audioEditorWaveform';
import './AudioSplitterModal.css';

function fileStem(name) {
  const clean = name || 'audio';
  const dot = clean.lastIndexOf('.');
  return dot > 0 ? clean.slice(0, dot) : clean;
}

function stripAudioExtension(name) {
  return String(name || '').trim().replace(/\.(mp3|flac|wav|ogg|m4a|aac|webm)$/i, '');
}

function defaultSegmentName(sourceName, index) {
  return `${fileStem(sourceName)}_extrait_${String(index).padStart(2, '0')}.flac`;
}

function readableError(value) {
  const text = String(value || '').trim();
  if (!text) return "Le découpage audio a échoué.";
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || text;
  if (/ffmpeg|invalid data|error/i.test(text)) {
    return `FFmpeg n'a pas pu découper cet audio. ${firstLine}`;
  }
  return firstLine;
}

export function AudioSplitterModal({
  item,
  savePath,
  onClose,
  onCreated,
}) {
  const { workspaceDir } = useProjectContext();
  const sourceUrl = useLocalFile(item?.path);
  const containerRef = useRef(null);
  const wsRef = useRef(null);
  const regionRef = useRef(null);
  const durationRef = useRef(0);
  const isClampingRef = useRef(false);
  const skipNextZoomEffectRef = useRef(false);
  const auditionEndRef = useRef(null);
  const counterRef = useRef(1);

  const [duration, setDuration] = useState(0);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [segments, setSegments] = useState([]);
  const [zoom, setZoom] = useState(80);
  const [loading, setLoading] = useState(true);
  const [, setPreviewingKey] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const sourceName = item?.name || basename(item?.path || 'audio');
  const selectionDuration = Math.max(0, selection.end - selection.start);
  const canUseSelection = !loading && selection.end > selection.start;
  const canSubmit = segments.length > 0 && !submitting;

  const {
    shuttleRef,
    currentTime,
    setCurrentTime,
    isPlaying,
    setIsPlaying,
    shuttleStatus,
    setWaveTime,
    getCurrentAudioTime,
    stopShuttle,
    nudgeWithScrub,
    bumpShuttle,
    resetReverseBuffer,
  } = useShuttlePlayback({ wsRef, durationRef });

  useEffect(() => {
    if (!sourceUrl || !containerRef.current) return undefined;
    let mounted = true;
    const wsRegions = RegionsPlugin.create();
    setLoading(true);
    setError('');
    setIsPlaying(false);
    setCurrentTime(0);
    resetReverseBuffer();
    wsRef.current = null;
    regionRef.current = null;

    const ws = WaveSurfer.create(createAudioEditorWaveformOptions({
      container: containerRef.current,
      url: sourceUrl,
      plugins: [wsRegions],
    }));

    ws.on('ready', (dur) => {
      if (!mounted) return;
      wsRef.current = ws;
      const safeDuration = Number.isFinite(dur) ? dur : 0;
      durationRef.current = safeDuration;
      setDuration(safeDuration);
      const end = parseFloat(safeDuration.toFixed(3));
      setSelection({ start: 0, end });
      const region = wsRegions.addRegion({
        id: 'audio-split-selection-region',
        start: 0,
        end,
        color: 'rgba(37, 99, 235, 0.30)',
        drag: false,
        resize: true,
      });
      styleRegionHandles(region, '#60a5fa');
      regionRef.current = region;
      const containerWidth = containerRef.current?.clientWidth ?? 600;
      setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.floor(containerWidth / Math.max(1, safeDuration)))));
      setLoading(false);
    });

    ws.on('error', () => {
      if (!mounted) return;
      setLoading(false);
      setError('Impossible de charger le fichier audio.');
    });
    ws.on('play', () => { if (mounted) setIsPlaying(true); });
    ws.on('pause', () => {
      if (!mounted) return;
      setIsPlaying(false);
      if (auditionEndRef.current !== null) {
        auditionEndRef.current = null;
        setPreviewingKey(null);
      }
    });
    ws.on('finish', () => {
      if (!mounted) return;
      setIsPlaying(false);
      auditionEndRef.current = null;
      setPreviewingKey(null);
    });
    ws.on('timeupdate', (time) => {
      if (!mounted) return;
      const auditionEnd = auditionEndRef.current;
      if (auditionEnd !== null && time >= auditionEnd - 0.01) {
        auditionEndRef.current = null;
        setPreviewingKey(null);
        ws.pause();
        ws.setTime(Math.min(auditionEnd, durationRef.current || auditionEnd));
        setCurrentTime(Math.min(auditionEnd, durationRef.current || auditionEnd));
        return;
      }
      setCurrentTime(time);
    });

    wsRegions.on('region-updated', (region) => {
      if (!mounted || region.id !== 'audio-split-selection-region' || isClampingRef.current) return;
      const dur = durationRef.current;
      let { start, end } = region;
      const nextStart = Math.max(0, Math.min(start, dur));
      const nextEnd = Math.max(0, Math.min(end, dur));
      if (nextStart !== start || nextEnd !== end) {
        isClampingRef.current = true;
        region.setOptions({ start: nextStart, end: nextEnd });
        isClampingRef.current = false;
        start = nextStart;
        end = nextEnd;
      }
      setSelection({
        start: parseFloat(start.toFixed(3)),
        end: parseFloat(end.toFixed(3)),
      });
    });

    function handleWheel(e) {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const pointer = getWavePointer(e);
      setZoom((value) => {
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value - e.deltaY * WHEEL_ZOOM_SENSITIVITY));
        skipNextZoomEffectRef.current = true;
        zoomAtPointer(next, pointer);
        return next;
      });
    }
    containerRef.current?.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      mounted = false;
      auditionEndRef.current = null;
      setPreviewingKey(null);
      stopShuttle();
      containerRef.current?.removeEventListener('wheel', handleWheel);
      ws.destroy();
      if (wsRef.current === ws) wsRef.current = null;
      regionRef.current = null;
    };
  }, [sourceUrl]);

  useEffect(() => {
    if (!wsRef.current || loading) return;
    if (skipNextZoomEffectRef.current) {
      skipNextZoomEffectRef.current = false;
      return;
    }
    applyWaveZoom(zoom);
  }, [zoom, loading]);

  function setRegion(start, end) {
    const dur = durationRef.current || duration;
    let nextStart = Math.max(0, Math.min(start, dur));
    let nextEnd = Math.max(0, Math.min(end, dur));
    if (nextEnd < nextStart) {
      if (nextStart < dur) nextEnd = Math.min(dur, nextStart + 0.001);
      else nextStart = Math.max(0, nextEnd - 0.001);
    }
    nextStart = parseFloat(nextStart.toFixed(3));
    nextEnd = parseFloat(nextEnd.toFixed(3));
    regionRef.current?.setOptions({ start: nextStart, end: nextEnd });
    setSelection({ start: nextStart, end: nextEnd });
  }

  function markStartHere() {
    const currentEnd = regionRef.current?.end ?? selection.end;
    setRegion(getCurrentAudioTime(), currentEnd);
  }

  function markEndHere() {
    const currentStart = regionRef.current?.start ?? selection.start;
    setRegion(currentStart, getCurrentAudioTime());
  }

  function handlePlayPause() {
    if (shuttleRef.current) {
      stopShuttle();
      return;
    }
    wsRef.current?.playPause();
  }

  function stopPlayback() {
    stopShuttle();
    wsRef.current?.stop();
    setCurrentTime(0);
  }

  function goToSelectionStart() {
    stopShuttle();
    setWaveTime(regionRef.current?.start ?? selection.start);
  }

  function goToSelectionEnd() {
    stopShuttle();
    setWaveTime(regionRef.current?.end ?? selection.end);
  }

  function zoomAtCursor(delta) {
    setZoom((value) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value + delta)));
  }

  function getWavePointer(e) {
    const ws = wsRef.current;
    const wrapper = ws?.getWrapper?.();
    const scroller = wrapper?.parentElement;
    const fallback = containerRef.current;
    const rect = (scroller ?? wrapper ?? fallback)?.getBoundingClientRect?.();
    const dur = durationRef.current || 0;
    if (!rect || !dur) return null;
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const scroll = ws?.getScroll?.() ?? scroller?.scrollLeft ?? 0;
    const totalWidth = wrapper?.scrollWidth || wrapper?.clientWidth || rect.width;
    const pxPerSec = totalWidth / dur;
    if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return null;
    return {
      x,
      time: Math.max(0, Math.min((scroll + x) / pxPerSec, dur)),
      scroller,
      clientWidth: scroller?.clientWidth ?? rect.width,
    };
  }

  function applyWaveZoom(nextZoom, instance = wsRef.current) {
    if (!instance) return false;
    try {
      if ((instance.getDuration?.() ?? 0) <= 0) return false;
      instance.zoom(nextZoom);
      return true;
    } catch {
      return false;
    }
  }

  function zoomAtPointer(nextZoom, pointer) {
    const ws = wsRef.current;
    if (!ws) return;
    if (!applyWaveZoom(nextZoom, ws)) return;
    if (!pointer) return;
    const dur = durationRef.current || 0;
    const clientWidth = pointer.clientWidth || pointer.scroller?.clientWidth || 0;
    if (!dur || !clientWidth) return;
    if (nextZoom * dur <= clientWidth) {
      ws.setScroll?.(0);
      if (pointer.scroller) pointer.scroller.scrollLeft = 0;
      return;
    }
    const nextScroll = Math.max(0, pointer.time * nextZoom - pointer.x);
    ws.setScroll?.(nextScroll);
    if (pointer.scroller) pointer.scroller.scrollLeft = nextScroll;
  }

  useAudioEditorShortcuts({
    isLoading: loading,
    canOperate: false,
    canCut: false,
    stagedEdit: null,
    previewPath: null,
    actions: {
      undo: () => {},
      zoomIn: () => zoomAtCursor(KEYBOARD_ZOOM_STEP),
      zoomOut: () => zoomAtCursor(-KEYBOARD_ZOOM_STEP),
      clearStart: () => {},
      clearEnd: () => {},
      trimSelection: () => {},
      cutSelection: () => {},
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
      previewIn: goToSelectionStart,
      previewOut: goToSelectionEnd,
    },
  });

  function previewRange(range, key) {
    if (!range || range.end <= range.start) {
      setError("La sélection doit avoir un point de sortie après le point d'entrée.");
      return;
    }
    setError('');
    const dur = durationRef.current || duration;
    const start = Math.max(0, Math.min(range.start, dur));
    const end = Math.max(start, Math.min(range.end, dur));
    stopShuttle();
    auditionEndRef.current = end;
    setPreviewingKey(key);
    setWaveTime(start);
    void wsRef.current?.play();
  }

  function addSegment() {
    if (!canUseSelection) {
      setError("La sélection doit avoir un point de sortie après le point d'entrée.");
      return;
    }
    const index = counterRef.current;
    counterRef.current += 1;
    const id = `${Date.now()}-${index}`;
    setSegments((current) => ([
      ...current,
      {
        id,
        outputFileName: defaultSegmentName(sourceName, index),
        startSec: selection.start,
        endSec: selection.end,
      },
    ]));
    setError('');
  }

  function updateSegmentName(id, value) {
    setSegments((current) => current.map((segment) => (
      segment.id === id ? { ...segment, outputFileName: value } : segment
    )));
  }

  function removeSegment(id) {
    setSegments((current) => current.filter((segment) => segment.id !== id));
  }

  async function handleSubmit() {
    setError('');
    if (!savePath && !workspaceDir) {
      setError('Enregistrez le projet avant de découper un audio.');
      return;
    }
    if (segments.length === 0) {
      setError('Ajoutez au moins un extrait à générer.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await invoke('split_audio_segments', {
        savePath: savePath || '',
        inputPath: item.path,
        segments: segments.map((segment) => ({
          outputFileName: stripAudioExtension(segment.outputFileName) || 'extrait',
          startSec: segment.startSec,
          endSec: segment.endSec,
        })),
        workspaceDir: workspaceDir || null,
      });
      const createdPaths = result?.created?.map((entry) => entry.outputPath).filter(Boolean) ?? [];
      if (createdPaths.length === 0) {
        const firstFailure = result?.failed?.[0]?.error;
        setError(firstFailure ? readableError(firstFailure) : "Aucun extrait n'a pu être généré.");
        return;
      }
      onCreated?.(createdPaths, result?.failed ?? []);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box audio-splitter-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span>Découper un audio</span>
          <Button variant="icon" className="modal-close" onClick={onClose} disabled={submitting}>×</Button>
        </div>

        <div className="audio-splitter-body">
          <div className="audio-splitter-source" title={item.path}>
            <span>Source</span>
            <strong>{sourceName}</strong>
          </div>

          <section className="audio-splitter-wave-section">
            <div className="audio-splitter-wave-header">
              <div className="audio-splitter-time">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
                {shuttleStatus && <span className="audio-editor-shuttle-status">{shuttleStatus}</span>}
              </div>
            </div>
            <div className="audio-splitter-waveform-wrap">
              {loading && <div className="audio-splitter-loading">Chargement…</div>}
              <div ref={containerRef} className="audio-splitter-waveform" />
            </div>
            <div className="audio-splitter-toolbar">
              <div className="audio-tb">
                <Tooltip text="Marquer le point d'entrée à la position du curseur (i)">
                  <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={markStartHere} disabled={loading}>{`{`}</Button>
                </Tooltip>
                <Tooltip text="Marquer le point de sortie à la position du curseur (o)">
                  <Button variant="icon" className="audio-tb-btn audio-tb-btn-marker" onClick={markEndHere} disabled={loading}>{`}`}</Button>
                </Tooltip>

                <div className="audio-tb-sep" />

                <Tooltip text={isPlaying ? 'Pause (Espace)' : 'Play / Pause (Espace)'}>
                  <Button variant="icon" className={`audio-tb-btn${isPlaying ? ' is-active' : ''}`} onClick={handlePlayPause} disabled={loading}>
                    {isPlaying ? <Pause /> : <Play />}
                  </Button>
                </Tooltip>
                <Tooltip text="Stop">
                  <Button variant="icon" className="audio-tb-btn" onClick={stopPlayback} disabled={loading}><Square /></Button>
                </Tooltip>
                <Tooltip text="Reculer de 5s">
                  <Button variant="icon" className="audio-tb-btn" onClick={() => { stopShuttle(); wsRef.current?.skip(-SKIP_STEP); }} disabled={loading}><SkipBack /></Button>
                </Tooltip>
                <Tooltip text="Avancer de 5s">
                  <Button variant="icon" className="audio-tb-btn" onClick={() => { stopShuttle(); wsRef.current?.skip(SKIP_STEP); }} disabled={loading}><SkipForward /></Button>
                </Tooltip>

                <div className="audio-tb-sep" />

                <Tooltip text="Aller au point d'entrée (Shift+I)">
                  <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={goToSelectionStart} disabled={loading}>|▶</Button>
                </Tooltip>
                <Tooltip text="Aller au point de sortie (Shift+O)">
                  <Button variant="icon" className="audio-tb-btn audio-tb-btn-text" onClick={goToSelectionEnd} disabled={loading}>▶|</Button>
                </Tooltip>
              </div>
            </div>
            <div className="audio-editor-row audio-editor-zoom-row audio-splitter-zoom-row">
              <span className="audio-editor-label">Zoom</span>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={5}
                value={zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                className="audio-editor-zoom-slider"
                disabled={loading}
              />
              <span className="audio-editor-zoom-val">×{(zoom / 20).toFixed(1)}</span>
              <span className="audio-editor-hint">Ctrl+molette / +/- · ← → 50ms · J/K/L · Début/Fin</span>
            </div>
          </section>

          <section className="audio-splitter-selection">
            <div className="audio-splitter-selection-stats">
              <span>Entrée <strong>{formatTime(selection.start)}</strong></span>
              <span>Sortie <strong>{formatTime(selection.end)}</strong></span>
              <span>Durée <strong>{formatTime(selectionDuration)}</strong></span>
            </div>
            <div className="audio-splitter-selection-actions">
              <Button onClick={() => previewRange({ start: selection.start, end: selection.end }, 'active')} disabled={!canUseSelection}>
                Prévisualiser
              </Button>
              <Button variant="primary" onClick={addSegment} disabled={!canUseSelection}>
                <Scissors className="audio-splitter-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                Ajouter l'extrait
              </Button>
            </div>
          </section>

          <section className="audio-splitter-section">
            <h3>Extraits à générer</h3>
            {segments.length === 0 ? (
              <div className="audio-splitter-empty">Aucun extrait ajouté.</div>
            ) : (
              <div className="audio-splitter-list">
                {segments.map((segment, index) => (
                  <div className="audio-splitter-row" key={segment.id}>
                    <span className="audio-splitter-row-index">{index + 1}</span>
                    <input
                      className="audio-splitter-name-input"
                      value={segment.outputFileName}
                      onChange={(e) => updateSegmentName(segment.id, e.target.value)}
                      disabled={submitting}
                    />
                    <span className="audio-splitter-range">
                      {formatTime(segment.startSec)} → {formatTime(segment.endSec)}
                    </span>
                    <Button
                      variant="icon"
                      className="audio-splitter-icon-btn"
                      onClick={() => previewRange({ start: segment.startSec, end: segment.endSec }, segment.id)}
                      disabled={submitting}
                      title="Prévisualiser cet extrait"
                    >
                      <Play strokeWidth={2} absoluteStrokeWidth />
                    </Button>
                    <Button
                      variant="icon"
                      className="audio-splitter-icon-btn is-danger"
                      onClick={() => removeSegment(segment.id)}
                      disabled={submitting}
                      title="Supprimer cet extrait"
                    >
                      <Trash2 strokeWidth={2} absoluteStrokeWidth />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="audio-splitter-destination">
            <span>Destination</span>
            <strong>fichiers-importes/</strong>
          </div>

          {error && <div className="audio-splitter-error">{error}</div>}
        </div>

        <div className="audio-splitter-footer">
          <Button onClick={onClose} disabled={submitting}>Annuler</Button>
          <Button variant="primary" className="audio-splitter-submit" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting && <span className="audio-splitter-spinner" />}
            {submitting ? 'Génération…' : 'Générer'}
          </Button>
        </div>
      </div>
    </div>
  );
}
