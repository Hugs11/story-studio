import { useEffect, useRef, useState } from 'react';
import { useLocalFile } from '../../hooks/useLocalFile';
import { formatDuration } from './helpers';

const durationCache = new Map();

export function useAudioDuration(path, exists) {
  const [duration, setDuration] = useState(() => durationCache.get(path) ?? null);
  const [visible, setVisible] = useState(false);
  const ref = useRef(null);
  const shouldLoad = visible && exists && !!path && !durationCache.has(path);
  const url = useLocalFile(shouldLoad ? path : null);

  useEffect(() => {
    if (!path || !exists || durationCache.has(path)) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: '120px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [path, exists]);

  useEffect(() => {
    if (!url) return;
    if (durationCache.has(path)) { setDuration(durationCache.get(path)); return; }
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    audio.onloadedmetadata = () => {
      const d = formatDuration(audio.duration);
      durationCache.set(path, d);
      setDuration(d);
      audio.src = '';
    };
    audio.onerror = () => { audio.src = ''; };
    return () => { audio.src = ''; };
  }, [url, path]);

  return [duration, ref];
}
