import { useCallback, useEffect, useState } from 'react';

export function useAudioTimeline(audioRef) {
  const [timeline, setTimeline] = useState({ hasAudio: false, currentTime: 0, duration: 0 });

  useEffect(() => {
    function readTimeline() {
      const audio = audioRef.current;
      if (!audio) {
        setTimeline((prev) => (
          prev.hasAudio || prev.currentTime !== 0 || prev.duration !== 0
            ? { hasAudio: false, currentTime: 0, duration: 0 }
            : prev
        ));
        return;
      }

      const nextDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      const nextCurrentTime = Number.isFinite(audio.currentTime) && audio.currentTime >= 0
        ? Math.min(audio.currentTime, nextDuration || audio.currentTime)
        : 0;

      setTimeline((prev) => (
        prev.hasAudio
        && Math.abs(prev.currentTime - nextCurrentTime) < 0.1
        && Math.abs(prev.duration - nextDuration) < 0.1
          ? prev
          : { hasAudio: true, currentTime: nextCurrentTime, duration: nextDuration }
      ));
    }

    readTimeline();
    const timer = setInterval(readTimeline, 200);
    return () => clearInterval(timer);
  }, [audioRef]);

  const seekTo = useCallback((nextTime) => {
    const audio = audioRef.current;
    if (!audio) return;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const clamped = Math.max(0, Math.min(duration || Math.max(nextTime, 0), nextTime));
    try {
      audio.currentTime = clamped;
      setTimeline({
        hasAudio: true,
        currentTime: clamped,
        duration,
      });
    } catch {}
  }, [audioRef]);

  return { timeline, seekTo };
}

