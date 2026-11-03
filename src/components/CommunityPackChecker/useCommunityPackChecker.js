import { catalogueFilesApi } from '../../store/catalogue/catalogueFilesApi.js';
import { createCheckerPreparationLifetime } from '../../store/catalogue/checkerPreparation.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { presentCheckerReport } from '../../i18n/checkerMessages.js';
import { presentStoredError } from '../../i18n/userMessage.js';
import { presentUserMessage } from '../../i18n/userMessage.js';
import { checkerRef, translateChecker } from '../../i18n/checkerPresentation.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { pickFolder } from '../../hooks/useFileDialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  formatDiagnosticJson,
  formatHtmlReport,
  formatReadableReport,
  formatTechnicalLog,
  reportBaseName,
} from './communityPackExports';
import { convertFolderPackToZip, readPathKinds } from '../../utils/packFolder';
import { basename } from '../../utils/fileUtils';
import { isTauriRuntime } from '../../utils/tauriRuntime';
import { releaseTauriListener } from '../../utils/tauriListener';

// Clés des filtres natifs et des notices, résolues au clic (langue active).
const EXPORTS = {
  report: {
    extension: 'html',
    noticeKey: 'checker:export.notice.html',
    filterKey: 'native:checker.report.html.filterLabel',
    extensions: ['html'],
    content: formatHtmlReport,
  },
  markdown: {
    extension: 'md',
    noticeKey: 'checker:export.notice.markdown',
    filterKey: 'native:checker.report.markdown.filterLabel',
    extensions: ['md'],
    content: formatReadableReport,
  },
  log: {
    extension: 'txt',
    noticeKey: 'checker:export.notice.log',
    filterKey: 'native:checker.report.log.filterLabel',
    extensions: ['txt'],
    content: formatTechnicalLog,
  },
  json: {
    extension: 'json',
    noticeKey: 'checker:export.notice.json',
    filterKey: 'native:checker.report.json.filterLabel',
    extensions: ['json'],
    content: formatDiagnosticJson,
  },
};

export function useCommunityPackChecker(initialEntry = null, preparationLifetime = null) {
  useMessageLanguage();
  const [zipPath, setZipPath] = useState('');
  // Dossier choisi ou déposé : `zipPath` est alors l'archive qu'il est devenu.
  const [sourceFolder, setSourceFolder] = useState('');
  const [report, setReport] = useState(null);
  const [fixedResult, setFixedResult] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const [technicalDetail, setTechnicalDetail] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const [liveLog, setLiveLog] = useState([]);
  const statusRef = useRef(status);
  const [preparation] = useState(() => preparationLifetime ?? (initialEntry ? createCheckerPreparationLifetime(
    () => catalogueFilesApi.releaseChecker(initialEntry.preparationId), setError,
  ) : null));
  useEffect(() => preparation?.retain(), [preparation]);

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
      appendLiveLog(event.payload);
    }).then((fn) => {
      if (cancelled) releaseTauriListener(fn);
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      releaseTauriListener(unlisten);
    };
  }, [appendLiveLog]);

  const analyzePath = useCallback(async (path, options = {}) => {
    const nextPath = String(path || '').trim();
    if (!nextPath) return null;
    const finishTask = preparation?.beginTask();
    setZipPath(nextPath);
    setFixedResult(null);
    setError('');
    setTechnicalDetail('');
    setExportNotice('');
    statusRef.current = 'analyzing';
    setStatus('analyzing');
    if (options.appendLog) {
      appendLiveLog(options.label || checkerRef('checker:log.reanalysis.requested'));
    } else {
      setLiveLog([checkerRef('checker:log.analysis.requested')]);
    }
    try {
      // Un dossier de pack vaut une archive : converti par le lecteur unique du moteur.
      let analysisPath = nextPath;
      let folder = '';
      if ((await readPathKinds([nextPath]))?.get(nextPath) === 'folder') {
        analysisPath = await convertFolderPackToZip(nextPath);
        folder = nextPath;
        setZipPath(analysisPath);
      }
      setSourceFolder(folder);
      const analyzed = await invoke('analyze_community_pack', {
        zipPath: analysisPath,
        preparationId: initialEntry?.preparationId ?? null,
        expectedContentToken: analysisPath === initialEntry?.zipPath ? initialEntry.contentToken : null,
      });
      const nextReport = folder ? { ...analyzed, packName: basename(folder) } : analyzed;
      setReport(nextReport);
      const finalLines = (nextReport?.technicalLog || []).slice(-3);
      setLiveLog((current) => [
        ...current,
        ...finalLines,
        checkerRef('checker:log.analysis.done'),
      ].slice(-9));
      statusRef.current = 'idle';
      setStatus('idle');
      return nextReport;
    } catch (err) {
      const presented = presentUserMessage(err);
      appendLiveLog(checkerRef('checker:log.analysis.interrupted', { message: { userMessage: err } }));
      setError(err);
      setTechnicalDetail(presented.technicalDetail);
      statusRef.current = 'idle';
      setStatus('idle');
      return null;
    }
    finally { finishTask?.(); }
  }, [appendLiveLog, preparation, initialEntry]);

  const pickPack = useCallback(async () => {
    const selected = await open({
      multiple: false,
      filters: [{ name: translateChecker('native:file.pack.filterLabel'), extensions: ['zip', '7z'] }],
    });
    if (selected) {
      await analyzePath(Array.isArray(selected) ? selected[0] : selected);
    }
  }, [analyzePath]);

  const pickFolderPack = useCallback(async () => {
    const selected = await pickFolder();
    if (selected) await analyzePath(Array.isArray(selected) ? selected[0] : selected);
  }, [analyzePath]);

  const fixPack = useCallback(async (metadataPatch = null, options = {}) => {
    if (!zipPath) return null;
    const finishTask = preparation?.beginTask();
    setError('');
    setTechnicalDetail('');
    setExportNotice('');
    statusRef.current = 'fixing';
    setStatus('fixing');
    setLiveLog([checkerRef('checker:log.fix.requested')]);
    try {
      const result = await invoke('create_fixed_community_pack', {
        zipPath,
        preparationId: initialEntry?.preparationId ?? null,
        expectedContentToken: zipPath === initialEntry?.zipPath ? initialEntry.contentToken : null,
        outputDir: options.outputDir || null,
        metadataPatch,
        correctionSelection: options.correctionSelection || null,
        sourceLabel: sourceFolder || null,
      });
      appendLiveLog(checkerRef('checker:log.fix.created', { path: result.fixedZipPath }));
      appendLiveLog(checkerRef('checker:log.reanalysis.automatic'));
      // La réanalyse réinitialise fixedResult (via analyzePath) : on positionne
      // donc le résultat APRÈS, pour que la bannière « ZIP corrigé » persiste.
      const correctedReport = await analyzePath(result.fixedZipPath, {
        appendLog: true,
        label: checkerRef('checker:log.reanalysis.started'),
      });
      if (correctedReport) {
        // Ligne du journal gardée comme référence : l'export la rend dans la langue du clic.
        const correctionLine = checkerRef('checker:log.fix.applied', {
          automatic: checkerRef('checker:log.fix.automaticCount', { count: result.automaticCorrectionsApplied ?? 0 }),
          optional: checkerRef('checker:log.fix.optionalCount', { count: result.optionalAudioSilencesFixed ?? 0 }),
        });
        setReport({
          ...correctedReport,
          technicalLog: [...(correctedReport.technicalLog || []), correctionLine],
        });
      }
      setFixedResult(result);
      statusRef.current = 'idle';
      setStatus('idle');
      return result;
    } catch (err) {
      const presented = presentUserMessage(err);
      appendLiveLog(checkerRef('checker:log.fix.interrupted', { message: { userMessage: err } }));
      setError(err);
      setTechnicalDetail(presented.technicalDetail);
      statusRef.current = 'idle';
      setStatus('idle');
      return null;
    }
    finally { finishTask?.(); }
  }, [analyzePath, appendLiveLog, zipPath, sourceFolder, preparation, initialEntry]);

  const exportReport = useCallback(async (kind) => {
    if (!report || !EXPORTS[kind]) return;
    const config = EXPORTS[kind];
    const defaultName = `${reportBaseName(report)} - ${kind}.${config.extension}`;
    const target = await save({
      defaultPath: defaultName,
      filters: [{ name: translateChecker(config.filterKey), extensions: config.extensions }],
    });
    if (!target) return;
    try {
      await writeTextFile(target, config.content(report));
      setExportNotice(checkerRef(config.noticeKey));
    } catch (err) {
      setError(checkerRef('checker:export.error.failed', { message: { userMessage: err } }));
    }
  }, [report]);

  const copyLog = useCallback(async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(formatTechnicalLog(report));
      setExportNotice(checkerRef('checker:log.copy.done'));
    } catch {
      setError(checkerRef('checker:log.copy.failed'));
    }
  }, [report]);

  const openFixedLocation = useCallback(async () => {
    if (!fixedResult?.fixedZipPath) return;
    try {
      await openPath(fixedResult.fixedZipPath);
    } catch (err) {
      setError(checkerRef('checker:fix.open.failed', { message: { userMessage: err } }));
    }
  }, [fixedResult]);

  return {
    zipPath,
    report: presentCheckerReport(report),
    fixedResult,
    status,
    error: presentStoredError(error),
    exportNotice: presentStoredError(exportNotice),
    liveLog: liveLog.map((line) => presentStoredError(line)),
    analyzePath,
    sourceFolder,
    pickPack,
    pickFolderPack,
    technicalDetail,
    fixPack,
    exportReport,
    copyLog,
    openFixedLocation,
  };
}
