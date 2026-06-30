// Hook : gere la machinerie Web Audio "shuttle" de la modale d'edition
// audio. Permet le scrub avant/arriere a differentes vitesses (SHUTTLE_RATES)
// independamment de WaveSurfer.js qui ne supporte pas la lecture inverse.
//
// Etat expose :
//   currentTime, isPlaying, shuttleStatus + setters (consommes aussi par
//     les events WaveSurfer du parent)
//   shuttleRef (peek par handlePlayPause du parent)
//   clampAudioTime / setWaveTime / getCurrentAudioTime : helpers qui
//     manipulent le wavesurfer ET notre etat currentTime
// Actions :
//   getAudioContext : lazy init du AudioContext + resume si suspended
//   stopShuttle({ sync }) : arrete la source en cours, recale le cursor
//   startBufferPlayback({ direction, rate, startTime, duration, status })
//   nudgeWithScrub(delta) : micro-scrub avant courte duree
//   bumpShuttle(direction) : cycle SHUTTLE_RATES dans la direction donnee.
//     Le premier L en avant reste sur la lecture native WaveSurfer a 1x ;
//     Web Audio prend le relais seulement pour l'arriere ou les vitesses > 1x.

import { useRef, useState } from 'react';
import { SCRUB_DURATION, SHUTTLE_RATES } from './audioEditorConstants';
import { createReverseBuffer } from './audioEditorWaveform';

export function useShuttlePlayback({ wsRef, durationRef }) {
  const audioCtxRef = useRef(null);
  const shuttleRef = useRef(null);
  const reverseBufferRef = useRef(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuttleStatus, setShuttleStatus] = useState(null);

  function clampAudioTime(value) {
    const dur = durationRef.current || 0;
    return Math.max(0, Math.min(Number(value) || 0, dur));
  }

  function setWaveTime(time) {
    const next = clampAudioTime(time);
    wsRef.current?.setTime(next);
    setCurrentTime(next);
    return next;
  }

  function getCurrentAudioTime() {
    if (shuttleRef.current) return currentShuttleTime();
    return clampAudioTime(wsRef.current?.getCurrentTime?.() ?? currentTime);
  }

  function getAudioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
    if (audioCtxRef.current.state === 'suspended') {
      void audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }

  function getPlaybackBuffer(direction) {
    const buffer = wsRef.current?.getDecodedData?.();
    if (!buffer) return null;
    if (direction >= 0) return buffer;
    if (!reverseBufferRef.current || reverseBufferRef.current.length !== buffer.length) {
      reverseBufferRef.current = createReverseBuffer(buffer, getAudioContext());
    }
    return reverseBufferRef.current;
  }

  function currentShuttleTime() {
    const active = shuttleRef.current;
    const ctx = audioCtxRef.current;
    if (!active) return clampAudioTime(wsRef.current?.getCurrentTime?.() ?? currentTime);
    if (!ctx) return active.startTime;
    const elapsed = Math.max(0, ctx.currentTime - active.startedAt) * active.rate;
    return clampAudioTime(active.startTime + active.direction * elapsed);
  }

  function stopShuttle({ sync = true } = {}) {
    const active = shuttleRef.current;
    if (!active) {
      setShuttleStatus(null);
      return;
    }
    const nextTime = sync ? currentShuttleTime() : active.startTime;
    shuttleRef.current = null;
    if (active.rafId) cancelAnimationFrame(active.rafId);
    try {
      active.source.onended = null;
      active.source.stop();
    } catch {
      // Source may already be stopped by the Web Audio clock.
    }
    try {
      active.source.disconnect();
    } catch {
      // Already disconnected.
    }
    setWaveTime(nextTime);
    setIsPlaying(false);
    setShuttleStatus(null);
  }

  function startBufferPlayback({ direction, rate, startTime, duration: playDuration = null, status = null }) {
    const ctx = getAudioContext();
    const buffer = getPlaybackBuffer(direction);
    if (!ctx || !buffer) {
      setWaveTime(startTime);
      return false;
    }

    stopShuttle({ sync: true });
    wsRef.current?.pause();

    const dur = durationRef.current || buffer.duration;
    const clampedStart = clampAudioTime(startTime);
    const offset = direction >= 0 ? clampedStart : Math.max(0, dur - clampedStart);
    const maxDuration = direction >= 0 ? dur - clampedStart : clampedStart;
    if (maxDuration <= 0.005) {
      setWaveTime(clampedStart);
      return false;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.setValueAtTime(Math.max(0.25, rate), ctx.currentTime);
    source.connect(ctx.destination);

    const active = {
      source,
      direction,
      rate,
      startTime: clampedStart,
      startedAt: ctx.currentTime,
      rafId: null,
      scrub: playDuration !== null,
    };
    shuttleRef.current = active;
    setIsPlaying(true);
    setShuttleStatus(status);

    const syncCursor = () => {
      if (shuttleRef.current !== active) return;
      const next = currentShuttleTime();
      setWaveTime(next);
      const atEnd = direction >= 0 ? next >= dur - 0.001 : next <= 0.001;
      if (atEnd) {
        stopShuttle({ sync: true });
        return;
      }
      active.rafId = requestAnimationFrame(syncCursor);
    };
    if (!active.scrub) {
      active.rafId = requestAnimationFrame(syncCursor);
    }
    source.onended = () => {
      if (shuttleRef.current === active) stopShuttle({ sync: !active.scrub });
    };
    source.start(0, Math.max(0, Math.min(offset, buffer.duration)), Math.max(0.01, Math.min(playDuration ?? maxDuration, maxDuration)));
    return true;
  }

  function nudgeWithScrub(delta) {
    stopShuttle({ sync: !shuttleRef.current?.scrub });
    const next = setWaveTime(getCurrentAudioTime() + delta);
    startBufferPlayback({
      direction: 1,
      rate: 1,
      startTime: next,
      duration: Math.min(SCRUB_DURATION, Math.max(0.01, (durationRef.current || 0) - next)),
      status: null,
    });
  }

  function bumpShuttle(direction) {
    const active = shuttleRef.current;
    const waveIsPlaying = !!wsRef.current?.isPlaying?.();
    if (direction > 0 && !active && !waveIsPlaying) {
      setShuttleStatus(null);
      setIsPlaying(true);
      void wsRef.current?.play?.();
      return;
    }
    const sameDirection = active && !active.scrub && active.direction === direction;
    const currentRate = sameDirection ? active.rate : direction > 0 && waveIsPlaying ? 1 : 0;
    const currentIndex = SHUTTLE_RATES.findIndex((rate) => rate === currentRate);
    const nextRate = SHUTTLE_RATES[Math.min(SHUTTLE_RATES.length - 1, currentIndex + 1)] ?? SHUTTLE_RATES[0];
    const startTime = active ? currentShuttleTime() : getCurrentAudioTime();
    startBufferPlayback({
      direction,
      rate: nextRate,
      startTime,
      status: `${direction > 0 ? 'L' : 'J'} ×${nextRate}`,
    });
  }

  // Reset le buffer reverse cache (appele quand le fichier source change ;
  // sans ca le hook reutilise le reverse buffer du fichier precedent jusqu'a
  // ce que getPlaybackBuffer detecte un length different).
  function resetReverseBuffer() {
    reverseBufferRef.current = null;
  }

  return {
    audioCtxRef,
    shuttleRef,
    currentTime,
    setCurrentTime,
    isPlaying,
    setIsPlaying,
    shuttleStatus,
    clampAudioTime,
    setWaveTime,
    getCurrentAudioTime,
    getAudioContext,
    currentShuttleTime,
    stopShuttle,
    startBufferPlayback,
    nudgeWithScrub,
    bumpShuttle,
    resetReverseBuffer,
  };
}
