import { useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { KEYS, read, write, remove } from '../store/persistentSettings';
import { pathKey } from '../utils/fileUtils';

const CACHE_PREFIX = KEYS.MEDIA_METADATA_PREFIX;
const TTL_MS = 7 * 24 * 3600 * 1000;

function readCache(path) {
  const data = read(CACHE_PREFIX + pathKey(path), { parse: JSON.parse });
  if (!data) return null;
  if (Date.now() - (data.ts ?? 0) > TTL_MS) {
    remove(CACHE_PREFIX + pathKey(path));
    return null;
  }
  return data;
}

function writeCache(meta) {
  write(
    CACHE_PREFIX + pathKey(meta.path),
    { ...meta, ts: Date.now() },
    { serialize: JSON.stringify },
  );
}

export function fmtSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function fmtHz(hz) {
  if (!hz) return '';
  return hz >= 1000 ? `${(Math.round(hz / 100) / 10)} kHz` : `${hz} Hz`;
}

export function useMediaMetadata() {
  const [meta, setMeta] = useState(new Map());
  const pendingRef = useRef(new Set());
  const inFlightRef = useRef(new Set());
  const timerRef = useRef(null);

  const flushBatch = useCallback(async () => {
    const toProbe = [...pendingRef.current].filter((p) => !inFlightRef.current.has(pathKey(p)));
    pendingRef.current.clear();
    if (!toProbe.length) return;

    toProbe.forEach((p) => inFlightRef.current.add(pathKey(p)));
    try {
      const results = await invoke('probe_media_files', { paths: toProbe });
      setMeta((prev) => {
        const next = new Map(prev);
        for (const r of results) {
          writeCache(r);
          next.set(pathKey(r.path), r);
        }
        return next;
      });
    } catch {
      // Probe errors are non-fatal — columns show "—"
    } finally {
      toProbe.forEach((p) => inFlightRef.current.delete(pathKey(p)));
    }
  }, []);

  const markForProbe = useCallback((path) => {
    const key = pathKey(path);
    if (inFlightRef.current.has(key)) return;

    const cached = readCache(path);
    if (cached) {
      setMeta((prev) => {
        if (prev.has(key)) return prev;
        const next = new Map(prev);
        next.set(key, cached);
        return next;
      });
      return;
    }

    pendingRef.current.add(path);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(flushBatch, 300);
  }, [flushBatch]);

  const getMeta = useCallback((path) => {
    return meta.get(pathKey(path)) ?? null;
  }, [meta]);

  return { getMeta, markForProbe };
}
