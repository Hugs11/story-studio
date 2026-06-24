import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { openPath } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatDiagnosticJson,
  formatHtmlReport,
  formatReadableReport,
  formatTechnicalLog,
  reportBaseName,
} from './communityPackExports';
import { isTauriRuntime } from '../../utils/tauriRuntime';

const EXPORTS = {
  report: {
    extension: 'html',
    label: 'Rapport HTML',
    filter: { name: 'Rapport HTML', extensions: ['html'] },
    content: formatHtmlReport,
  },
  markdown: {
    extension: 'md',
    label: 'Rapport Markdown',
    filter: { name: 'Rapport Markdown', extensions: ['md'] },
    content: formatReadableReport,
  },
  log: {
    extension: 'txt',
    label: 'Journal technique',
    filter: { name: 'Journal texte', extensions: ['txt'] },
    content: formatTechnicalLog,
  },
  json: {
    extension: 'json',
    label: 'Diagnostic JSON',
    filter: { name: 'Diagnostic JSON', extensions: ['json'] },
    content: formatDiagnosticJson,
  },
};

export function useCommunityPackChecker() {
  const [zipPath, setZipPath] = useState('');
  const [report, setReport] = useState(null);
  const [fixedResult, setFixedResult] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const [liveLog, setLiveLog] = useState([]);
  const statusRef = useRef(status);

  const appendLiveLog = useCallback((line) => {
    if (!line) return;
    setLiveLog((current) => [...current, line].slice(-10));
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!isTauriRuntime()) return undefined;
    let cancelled = false;
    let unlisten = null;
    listen('community-pack-checker-log', (event) => {
      if (statusRef.current !== 'analyzing' && statusRef.current !== 'fixing') return;
      appendLiveLog(String(event.payload || ''));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [appendLiveLog]);

  const analyzePath = useCallback(async (path, options = {}) => {
    const nextPath = String(path || '').trim();
    if (!nextPath) return null;
    setZipPath(nextPath);
    setFixedResult(null);
    setError('');
    setExportNotice('');
    statusRef.current = 'analyzing';
    setStatus('analyzing');
    if (options.appendLog) {
      appendLiveLog(options.label || 'Réanalyse du ZIP corrigé...');
    } else {
      setLiveLog(['Analyse du pack demandée...']);
    }
    try {
      const nextReport = await invoke('analyze_community_pack', {
        zipPath: nextPath,
      });
      setReport(nextReport);
      const finalLines = (nextReport?.technicalLog || []).slice(-3);
      setLiveLog((current) => [
        ...current,
        ...finalLines,
        'Analyse terminée.',
      ].slice(-9));
      statusRef.current = 'idle';
      setStatus('idle');
      return nextReport;
    } catch (err) {
      appendLiveLog(`Analyse interrompue : ${err}`);
      setError(String(err));
      statusRef.current = 'idle';
      setStatus('idle');
      return null;
    }
  }, [appendLiveLog]);

  const pickPack = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Pack Lunii ZIP', extensions: ['zip'] }],
    });
    if (selected) {
      await analyzePath(Array.isArray(selected) ? selected[0] : selected);
    }
  }, [analyzePath]);

  const fixPack = useCallback(async (metadataPatch = null, options = {}) => {
    if (!zipPath) return null;
    setError('');
    setExportNotice('');
    statusRef.current = 'fixing';
    setStatus('fixing');
    setLiveLog(['Correction du pack demandée...']);
    try {
      const result = await invoke('create_fixed_community_pack', {
        zipPath,
        outputDir: options.outputDir || null,
        metadataPatch,
      });
      appendLiveLog(`ZIP corrigé créé : ${result.fixedZipPath}`);
      appendLiveLog('Réanalyse automatique du ZIP corrigé...');
      // La réanalyse réinitialise fixedResult (via analyzePath) : on positionne
      // donc le résultat APRÈS, pour que la bannière « ZIP corrigé » persiste.
      await analyzePath(result.fixedZipPath, {
        appendLog: true,
        label: 'Analyse du ZIP corrigé...',
      });
      setFixedResult(result);
      statusRef.current = 'idle';
      setStatus('idle');
      return result;
    } catch (err) {
      appendLiveLog(`Correction interrompue : ${err}`);
      setError(String(err));
      statusRef.current = 'idle';
      setStatus('idle');
      return null;
    }
  }, [analyzePath, appendLiveLog, zipPath]);

  const exportReport = useCallback(async (kind) => {
    if (!report || !EXPORTS[kind]) return;
    const config = EXPORTS[kind];
    const defaultName = `${reportBaseName(report)} - ${kind}.${config.extension}`;
    const target = await save({
      defaultPath: defaultName,
      filters: [config.filter],
    });
    if (!target) return;
    try {
      await writeTextFile(target, config.content(report));
      setExportNotice(`${config.label} exporté.`);
    } catch (err) {
      setError(`Export impossible : ${err}`);
    }
  }, [report]);

  const copyLog = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatTechnicalLog(report));
      setExportNotice('Journal copié.');
    } catch {
      setError('Impossible de copier le journal.');
    }
  }, [report]);

  const openFixedLocation = useCallback(async () => {
    if (!fixedResult?.fixedZipPath) return;
    try {
      await openPath(fixedResult.fixedZipPath);
    } catch (err) {
      setError(`Impossible d'ouvrir le ZIP corrigé : ${err}`);
    }
  }, [fixedResult]);

  return {
    zipPath,
    report,
    fixedResult,
    status,
    error,
    exportNotice,
    liveLog,
    analyzePath,
    pickPack,
    fixPack,
    exportReport,
    copyLog,
    openFixedLocation,
  };
}
