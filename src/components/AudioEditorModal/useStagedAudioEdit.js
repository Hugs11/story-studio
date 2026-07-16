import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { logger } from '../../utils/logger';
import { markersAfterAction } from './audioEditorMarkers';
import { createAudioPreviewLifecycle } from './audioPreviewLifecycle';

const FADE_PREVIEW_DEBOUNCE_MS = 200;

// Transaction d'édition audio : charge l'édit sauvegardé (audio_edit_info),
// met en scène trim/cut/fondus via des previews ffmpeg (preview_audio_edit),
// puis valide (apply/commit) ou restaure l'original. Ce hook possède aussi
// l'ensemble des previews temporaires nécessaires aux éditions chaînées.
export function useStagedAudioEdit({
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
}) {
  const [sourcePath, setSourcePath] = useState(filePath);
  const [previewPath, setPreviewPath] = useState(null);
  const [editInfo, setEditInfo] = useState(null);
  const [stagedEdit, setStagedEdit] = useState(null);
  const [hasChainedPreview, setHasChainedPreview] = useState(false);
  const [cutMarkers, setCutMarkers] = useState([]);
  const [fadeInSec, setFadeInSec] = useState(0);
  const [fadeOutSec, setFadeOutSec] = useState(0);
  const [cutFadeSec, setCutFadeSec] = useState(0);
  const [applyMode, setApplyMode] = useState(null); // 'trim' | 'cut' | 'preview' | 'restore' | null
  const [previewStatus, setPreviewStatus] = useState('idle'); // idle | pending | ready | error

  const initialEditRef = useRef(null);
  const preStagedSelectionRef = useRef(null);
  const preStagedCutMarkersRef = useRef([]);
  const actionBasePathRef = useRef(filePath);
  const previewPathRef = useRef(null);
  const managedPreviewPathsRef = useRef(new Set());
  const lifecycleRef = useRef(null);
  const stagedEditRef = useRef(null);
  const fadeInSecRef = useRef(0);
  const fadeOutSecRef = useRef(0);
  const cutFadeSecRef = useRef(0);
  const outputFadeMaxRef = useRef(0);
  const cutFadeMaxRef = useRef(0);

  if (!lifecycleRef.current) {
    lifecycleRef.current = createAudioPreviewLifecycle({
      discardResult: releaseManagedPreview,
      onPendingChange: (pending) => {
        if (pending) {
          setPreviewStatus('pending');
          setApplyMode('preview');
        } else {
          setApplyMode((current) => current === 'preview' ? null : current);
        }
      },
      onError: (error) => {
        setPreviewStatus('error');
        setError(String(error));
      },
    });
  }

  const isPreviewPending = previewStatus === 'pending';
  const isBlockingAction = applyMode !== null && applyMode !== 'preview';
  const isApplying = isPreviewPending || isBlockingAction;
  const isPreviewingEdit = !!previewPath;
  const trimDuration = Math.max(0, trimEnd - trimStart);
  const fadeMax = Math.max(0, Math.min(10, trimDuration / 2));
  const outputFadeMax = isPreviewingEdit ? Math.max(0, Math.min(10, duration / 2)) : fadeMax;
  const cutFadeAnchor = stagedEdit?.mode === 'cut' ? stagedEdit.startSec : trimStart;
  const cutFadeMax = Math.max(0, Math.min(5, cutFadeAnchor));
  const canValidate = !!stagedEdit && previewStatus === 'ready' && !isBlockingAction;
  outputFadeMaxRef.current = outputFadeMax;
  cutFadeMaxRef.current = cutFadeMax;

  function setCurrentPreviewPath(path) {
    previewPathRef.current = path;
    setPreviewPath(path);
  }

  function setCurrentStagedEdit(edit) {
    stagedEditRef.current = edit;
    setStagedEdit(edit);
  }

  function updateFadeInSec(value) {
    fadeInSecRef.current = value;
    setFadeInSec(value);
  }

  function updateFadeOutSec(value) {
    fadeOutSecRef.current = value;
    setFadeOutSec(value);
  }

  function updateCutFadeSec(value) {
    cutFadeSecRef.current = value;
    setCutFadeSec(value);
  }

  function registerManagedPreview(path) {
    if (path) managedPreviewPathsRef.current.add(path);
    return path;
  }

  function releaseManagedPreview(path) {
    if (!path || !managedPreviewPathsRef.current.has(path)) {
      return Promise.resolve();
    }
    managedPreviewPathsRef.current.delete(path);
    return invoke('discard_audio_preview', { previewPath: path }).catch((error) => {
      logger.warn(`audio-editor:preview-discard-error path='${path}' error=${error}`);
    });
  }

  function releaseAllManagedPreviews() {
    const paths = [...managedPreviewPathsRef.current];
    paths.forEach((path) => { void releaseManagedPreview(path); });
  }

  async function producePreview(edit, inputPath) {
    const path = await invoke('preview_audio_edit', {
      inputPath,
      mode: edit.mode,
      startSec: edit.startSec,
      endSec: edit.endSec,
      savePath: savePath ?? null,
      workspaceDir: workspaceDir ?? null,
      fadeInSec: edit.fadeInSec,
      fadeOutSec: edit.fadeOutSec,
      cutFadeSec: edit.cutFadeSec,
    });
    return registerManagedPreview(path);
  }

  useEffect(() => () => {
    lifecycleRef.current?.dispose();
    releaseAllManagedPreviews();
  }, []);

  useEffect(() => {
    let cancelled = false;
    lifecycleRef.current.invalidate();
    releaseAllManagedPreviews();
    setSourcePath(filePath);
    setCurrentPreviewPath(null);
    setCurrentStagedEdit(null);
    setEditInfo(null);
    setHasChainedPreview(false);
    setCutMarkers([]);
    actionBasePathRef.current = filePath;
    preStagedSelectionRef.current = null;
    preStagedCutMarkersRef.current = [];
    updateFadeInSec(0);
    updateFadeOutSec(0);
    updateCutFadeSec(0);
    setPreviewStatus('idle');
    initialEditRef.current = null;
    invoke('audio_edit_info', {
      inputPath: filePath,
      savePath: savePath ?? null,
      workspaceDir: workspaceDir ?? null,
    }).then((info) => {
      if (cancelled) return;
      setEditInfo(info);
      if (info?.source_path) setSourcePath(info.source_path);
      if (info?.mode === 'cut' || info?.mode === 'trim') {
        setCurrentStagedEdit({
          mode: info.mode,
          startSec: Number(info?.start_sec ?? 0),
          endSec: Number(info?.end_sec ?? 0),
          fadeInSec: Number(info?.fade_in_sec ?? 0),
          fadeOutSec: Number(info?.fade_out_sec ?? 0),
          cutFadeSec: Number(info?.cut_fade_sec ?? 0),
        });
        setPreviewStatus('ready');
      }
      updateFadeInSec(Number(info?.fade_in_sec ?? 0));
      updateFadeOutSec(Number(info?.fade_out_sec ?? 0));
      updateCutFadeSec(Number(info?.cut_fade_sec ?? 0));
      const hasSavedSelection = Number.isFinite(Number(info?.start_sec))
        && Number.isFinite(Number(info?.end_sec))
        && Number(info.end_sec) > Number(info.start_sec);
      initialEditRef.current = hasSavedSelection
        ? {
            start: Number(info.start_sec),
            end: Number(info.end_sec),
          }
        : null;
    }).catch(() => {
      if (!cancelled) setSourcePath(filePath);
    });
    return () => { cancelled = true; };
  }, [filePath, savePath, workspaceDir]);

  function discardPreviewPath() {
    lifecycleRef.current.invalidate();
    const path = previewPathRef.current;
    setCurrentPreviewPath(null);
    setPreviewStatus('idle');
    if (actionBasePathRef.current === path) actionBasePathRef.current = filePath;
    void releaseManagedPreview(path);
  }

  function undoStagedEdit() {
    wsRef.current?.stop();
    lifecycleRef.current.invalidate();
    const previousSelection = preStagedSelectionRef.current;
    initialEditRef.current = previousSelection
      ? {
          start: previousSelection.start,
          end: previousSelection.end,
        }
      : null;
    setCurrentPreviewPath(null);
    setCurrentStagedEdit(null);
    setHasChainedPreview(false);
    setCutMarkers(preStagedCutMarkersRef.current ?? []);
    actionBasePathRef.current = filePath;
    releaseAllManagedPreviews();
    setPreviewStatus('idle');
    setApplyMode(null);
    setError(null);
  }

  function buildFadeEdit(overrides = {}) {
    const fullDuration = durationRef.current || duration;
    if (!fullDuration || fullDuration <= 0) return null;
    return {
      ...(stagedEditRef.current ?? {
        mode: 'trim',
        startSec: 0,
        endSec: fullDuration,
        cutFadeSec: 0,
      }),
      fadeInSec: Math.min(
        overrides.fadeInSec ?? fadeInSecRef.current,
        outputFadeMaxRef.current,
      ),
      fadeOutSec: Math.min(
        overrides.fadeOutSec ?? fadeOutSecRef.current,
        outputFadeMaxRef.current,
      ),
      cutFadeSec: Math.min(
        overrides.cutFadeSec ?? cutFadeSecRef.current,
        cutFadeMaxRef.current,
      ),
    };
  }

  function createFadePreviewTask(overrides = {}, target = null) {
    const edit = buildFadeEdit(overrides);
    if (!edit) return null;
    const sourcePathForPreview = actionBasePathRef.current || filePath;
    const hadStagedEdit = !!stagedEditRef.current;
    return {
      produce: () => producePreview(edit, sourcePathForPreview),
      apply: (path) => {
        if (target === 'cut') {
          setCutMarkers(markersAfterAction(
            preStagedCutMarkersRef.current ?? [],
            edit.mode,
            edit.startSec,
            edit.endSec,
            durationRef.current,
            edit.cutFadeSec,
          ));
        } else if (!hadStagedEdit) {
          actionBasePathRef.current = sourcePathForPreview;
          setCutMarkers([]);
        }
        const previousPreview = previewPathRef.current;
        setCurrentStagedEdit(edit);
        setCurrentPreviewPath(path);
        setPreviewStatus('ready');
        setError(null);
        if (previousPreview !== sourcePathForPreview) {
          void releaseManagedPreview(previousPreview);
        }
      },
    };
  }

  function regenerateFadePreview(overrides = {}, target = null) {
    const task = createFadePreviewTask(overrides, target);
    if (!task) return Promise.resolve({ status: 'ignored' });
    rememberWaveViewport();
    setError(null);
    return lifecycleRef.current.run(task);
  }

  function scheduleFadePreview(overrides = {}, target = null) {
    const task = createFadePreviewTask(overrides, target);
    if (!task) return;
    rememberWaveViewport();
    setError(null);
    lifecycleRef.current.debounce(task, FADE_PREVIEW_DEBOUNCE_MS);
  }

  async function handleRestoreOriginal() {
    stopShuttle();
    lifecycleRef.current.invalidate();
    setPreviewStatus('idle');
    setApplyMode('restore');
    setError(null);
    releaseAllManagedPreviews();
    try {
      const result = await invoke('restore_audio_original', {
        inputPath: filePath,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
      });
      onConfirm(result);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  function handleStageAction(mode) {
    stopShuttle();
    setError(null);
    const sourcePathForPreview = previewPathRef.current || filePath;
    const previousBasePath = actionBasePathRef.current;
    const willChainPreview = !!previewPathRef.current || hasChainedPreview;
    const nextCutMarkers = markersAfterAction(cutMarkers, mode, trimStart, trimEnd, durationRef.current, 0);
    preStagedCutMarkersRef.current = cutMarkers;
    preStagedSelectionRef.current = {
      start: trimStart,
      end: trimEnd,
    };
    const edit = {
      mode,
      startSec: trimStart,
      endSec: mode === 'cut' && trimEnd >= duration - 0.01 ? 1_000_000 : trimEnd,
      fadeInSec: fadeInSecRef.current,
      fadeOutSec: fadeOutSecRef.current,
      cutFadeSec: 0,
    };
    return lifecycleRef.current.run({
      produce: () => producePreview(edit, sourcePathForPreview),
      apply: (path) => {
        actionBasePathRef.current = sourcePathForPreview;
        setHasChainedPreview(willChainPreview);
        updateCutFadeSec(0);
        setCutMarkers(nextCutMarkers);
        setCurrentStagedEdit(edit);
        initialEditRef.current = null;
        const previousPreview = previewPathRef.current;
        setCurrentPreviewPath(path);
        setPreviewStatus('ready');
        setError(null);
        if (previousBasePath !== sourcePathForPreview && previousBasePath !== path) {
          void releaseManagedPreview(previousBasePath);
        }
        if (previousPreview !== sourcePathForPreview && previousPreview !== path) {
          void releaseManagedPreview(previousPreview);
        }
      },
    });
  }

  async function handleApply() {
    if (!canValidate) return;
    stopShuttle();
    setApplyMode(stagedEdit.mode);
    setError(null);
    try {
      const currentPreviewPath = previewPathRef.current;
      const result = hasChainedPreview && currentPreviewPath
        ? await invoke('commit_audio_preview', {
            inputPath: filePath,
            previewPath: currentPreviewPath,
            savePath: savePath ?? null,
            workspaceDir: workspaceDir ?? null,
          })
        : await invoke('apply_audio_edit', {
            inputPath: filePath,
            mode: stagedEdit.mode,
            startSec: stagedEdit.startSec,
            endSec: stagedEdit.endSec,
            savePath: savePath ?? null,
            workspaceDir: workspaceDir ?? null,
            fadeInSec: stagedEdit.fadeInSec,
            fadeOutSec: stagedEdit.fadeOutSec,
            cutFadeSec: stagedEdit.cutFadeSec,
          });
      releaseAllManagedPreviews();
      setCurrentPreviewPath(null);
      onConfirm(result);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  return {
    sourcePath,
    previewPath,
    discardPreviewPath,
    editInfo,
    stagedEdit,
    cutMarkers,
    fadeInSec,
    setFadeInSec: updateFadeInSec,
    fadeOutSec,
    setFadeOutSec: updateFadeOutSec,
    cutFadeSec,
    setCutFadeSec: updateCutFadeSec,
    applyMode,
    isApplying,
    isBlockingAction,
    isPreviewPending,
    isPreviewingEdit,
    fadeMax,
    outputFadeMax,
    cutFadeMax,
    canValidate,
    initialEditRef,
    undoStagedEdit,
    regenerateFadePreview,
    scheduleFadePreview,
    handleRestoreOriginal,
    handleStageAction,
    handleApply,
  };
}
