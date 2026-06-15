import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { openPath } from '@tauri-apps/plugin-opener';
import { useCallback, useState } from 'react';
import {
  formatDiagnosticJson,
  formatReadableReport,
  formatTechnicalLog,
  reportBaseName,
} from './communityPackExports';

const EXPORTS = {
  report: {
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

  const analyzePath = useCallback(async (path) => {
    const nextPath = String(path || '').trim();
    if (!nextPath) return null;
    setZipPath(nextPath);
    setFixedResult(null);
    setError('');
    setExportNotice('');
    setStatus('analyzing');
    try {
      const nextReport = await invoke('analyze_community_pack', { zipPath: nextPath });
      setReport(nextReport);
      setStatus('idle');
      return nextReport;
    } catch (err) {
      setError(String(err));
      setStatus('idle');
      return null;
    }
  }, []);

  const pickPack = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: 'Pack Lunii ZIP', extensions: ['zip'] }],
    });
    if (selected) {
      await analyzePath(Array.isArray(selected) ? selected[0] : selected);
    }
  }, [analyzePath]);

  const fixPack = useCallback(async () => {
    if (!zipPath) return;
    setError('');
    setExportNotice('');
    setStatus('fixing');
    try {
      const result = await invoke('create_fixed_community_pack', { zipPath });
      // La réanalyse réinitialise fixedResult (via analyzePath) : on positionne
      // donc le résultat APRÈS, pour que la bannière « ZIP corrigé » persiste.
      await analyzePath(result.fixedZipPath);
      setFixedResult(result);
      setStatus('idle');
    } catch (err) {
      setError(String(err));
      setStatus('idle');
    }
  }, [analyzePath, zipPath]);

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
    analyzePath,
    pickPack,
    fixPack,
    exportReport,
    copyLog,
    openFixedLocation,
  };
}
