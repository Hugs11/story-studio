import { useEffect, useState, useSyncExternalStore } from 'react';
import { measureAudioLevel } from '../store/audioLevel.js';
import { createAudioLevelWatcher } from '../store/audioLevelNotice.js';
import { readAudioLevelAlerts, subscribeAudioLevelAlerts } from '../store/audioLevelAlertSettings.js';
import { FILE_CHANGED_EVENT } from '../store/fileMetadataCache.js';
import { pathKey } from '../utils/fileUtils.js';
import { isTauriRuntime } from '../utils/tauriRuntime.js';

/**
 * Verdict brut de niveau du son `file` (ou null). La mesure part quand
 * l'élément `targetRef` devient visible, puis à chaque changement de fichier ou
 * retouche en place ; l'ancien verdict disparaît dès qu'une nouvelle mesure
 * part. Inerte sans fichier, hors Tauri, ou préférence désactivée.
 *
 * `version` : empreinte du contenu actuel du fichier (l'URL locale, qui change
 * quand la taille ou la date changent, y compris après une retouche externe).
 * `null` = pas encore connue, on attend ; `undefined` = non utilisée.
 */
export function useAudioLevelNotice(file, targetRef, { measure = measureAudioLevel, runtime = isTauriRuntime, version } = {}) {
  const alerts = useSyncExternalStore(subscribeAudioLevelAlerts, readAudioLevelAlerts, readAudioLevelAlerts);
  const active = !!file && alerts && runtime();
  // Visibilité et retouches sont rattachées au fichier : au changement de
  // fichier elles retombent sans effet intermédiaire, donc sans mesure doublée.
  const [visibleFor, setVisibleFor] = useState(null);
  const [revision, setRevision] = useState({ file: null, count: 0 });
  const [verdict, setVerdict] = useState({ key: null, notice: null });
  const visible = visibleFor === file;
  const count = revision.file === file ? revision.count : 0;
  const ready = version !== null;
  const key = `${file}\0${count}\0${version ?? ''}`;

  useEffect(() => {
    if (!active) return undefined;
    const element = targetRef?.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisibleFor(file);
      return undefined;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisibleFor(file);
      observer.disconnect();
    }, { rootMargin: '200px' }); // unité CSS
    observer.observe(element);
    return () => observer.disconnect();
  }, [file, active, targetRef]);

  useEffect(() => {
    if (!active) return undefined;
    function handleChanged(event) {
      if (pathKey(event?.detail?.path ?? '') !== pathKey(file)) return;
      setRevision((value) => ({ file, count: (value.file === file ? value.count : 0) + 1 }));
    }
    window.addEventListener(FILE_CHANGED_EVENT, handleChanged);
    return () => window.removeEventListener(FILE_CHANGED_EVENT, handleChanged);
  }, [file, active]);

  useEffect(() => {
    if (!active || !visible || !ready) return undefined;
    const watcher = createAudioLevelWatcher({
      measure,
      onVerdict: (notice) => setVerdict({ key, notice }),
    });
    watcher.start(file);
    return () => watcher.stop();
  }, [file, key, active, visible, ready, measure]);

  return active && ready && verdict.key === key ? verdict.notice : null;
}
