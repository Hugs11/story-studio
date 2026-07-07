import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { markersAfterAction } from './audioEditorMarkers';

// Transaction d'édition audio : charge l'édit sauvegardé (audio_edit_info),
// met en scène trim/cut/fondus via des previews ffmpeg (preview_audio_edit),
// puis valide (apply/commit) ou restaure l'original. Possède l'état de l'édit
// en cours (stagedEdit, preview, marqueurs de coupe, fondus).
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

  const initialEditRef = useRef(null);
  const preStagedSelectionRef = useRef(null);
  const preStagedCutMarkersRef = useRef([]);
  const actionBasePathRef = useRef(filePath);

  const isApplying = applyMode !== null;
  const isPreviewingEdit = !!previewPath;
  const trimDuration = Math.max(0, trimEnd - trimStart);
  const fadeMax = Math.max(0, Math.min(10, trimDuration / 2));
  const outputFadeMax = isPreviewingEdit ? Math.max(0, Math.min(10, duration / 2)) : fadeMax;
  const cutFadeAnchor = stagedEdit?.mode === 'cut' ? stagedEdit.startSec : trimStart;
  const cutFadeMax = Math.max(0, Math.min(5, cutFadeAnchor));
  const canValidate = !!stagedEdit && !isApplying;

  useEffect(() => {
    let cancelled = false;
    setSourcePath(filePath);
    setPreviewPath(null);
    setStagedEdit(null);
    setEditInfo(null);
    setHasChainedPreview(false);
    setCutMarkers([]);
    actionBasePathRef.current = filePath;
    preStagedSelectionRef.current = null;
    preStagedCutMarkersRef.current = [];
    setFadeInSec(0);
    setFadeOutSec(0);
    setCutFadeSec(0);
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
        setStagedEdit({
          mode: info.mode,
          startSec: Number(info?.start_sec ?? 0),
          endSec: Number(info?.end_sec ?? 0),
          fadeInSec: Number(info?.fade_in_sec ?? 0),
          fadeOutSec: Number(info?.fade_out_sec ?? 0),
          cutFadeSec: Number(info?.cut_fade_sec ?? 0),
        });
      }
      setFadeInSec(Number(info?.fade_in_sec ?? 0));
      setFadeOutSec(Number(info?.fade_out_sec ?? 0));
      setCutFadeSec(Number(info?.cut_fade_sec ?? 0));
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
  }, [filePath, savePath]);

  function discardPreviewPath() {
    setPreviewPath(null);
  }

  function undoStagedEdit() {
    wsRef.current?.stop();
    const previousSelection = preStagedSelectionRef.current;
    initialEditRef.current = previousSelection
      ? {
          start: previousSelection.start,
          end: previousSelection.end,
        }
      : null;
    setPreviewPath(null);
    setStagedEdit(null);
    setHasChainedPreview(false);
    setCutMarkers(preStagedCutMarkersRef.current ?? []);
    actionBasePathRef.current = filePath;
    setApplyMode(null);
    setError(null);
  }

  async function regenerateFadePreview(overrides = {}, target = null) {
    const fullDuration = durationRef.current || duration;
    if (!fullDuration || fullDuration <= 0) return;
    const edit = {
      ...(stagedEdit ?? {
        mode: 'trim',
        startSec: 0,
        endSec: fullDuration,
        cutFadeSec: 0,
      }),
      fadeInSec: Math.min(overrides.fadeInSec ?? fadeInSec, outputFadeMax),
      fadeOutSec: Math.min(overrides.fadeOutSec ?? fadeOutSec, outputFadeMax),
      cutFadeSec: Math.min(overrides.cutFadeSec ?? cutFadeSec, cutFadeMax),
    };
    rememberWaveViewport();
    setApplyMode('preview');
    setError(null);
    try {
      const sourcePathForPreview = actionBasePathRef.current || filePath;
      const path = await invoke('preview_audio_edit', {
        inputPath: sourcePathForPreview,
        mode: edit.mode,
        startSec: edit.startSec,
        endSec: edit.endSec,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
        fadeInSec: edit.fadeInSec,
        fadeOutSec: edit.fadeOutSec,
        cutFadeSec: edit.cutFadeSec,
      });
      if (target === 'cut') {
        setCutMarkers(markersAfterAction(
          preStagedCutMarkersRef.current ?? [],
          edit.mode,
          edit.startSec,
          edit.endSec,
          durationRef.current,
          edit.cutFadeSec,
        ));
      } else if (!stagedEdit) {
        actionBasePathRef.current = sourcePathForPreview;
        setCutMarkers([]);
      }
      setStagedEdit(edit);
      setPreviewPath(path);
      setApplyMode(null);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  async function handleRestoreOriginal() {
    stopShuttle();
    setApplyMode('restore');
    setError(null);
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

  async function handleStageAction(mode) {
    stopShuttle();
    setApplyMode('preview');
    setError(null);
    const sourcePathForPreview = previewPath || filePath;
    const willChainPreview = !!previewPath || hasChainedPreview;
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
      fadeInSec,
      fadeOutSec,
      cutFadeSec: 0,
    };
    try {
      const path = await invoke('preview_audio_edit', {
        inputPath: sourcePathForPreview,
        mode,
        startSec: edit.startSec,
        endSec: edit.endSec,
        savePath: savePath ?? null,
        workspaceDir: workspaceDir ?? null,
        fadeInSec: edit.fadeInSec,
        fadeOutSec: edit.fadeOutSec,
        cutFadeSec: edit.cutFadeSec,
      });
      actionBasePathRef.current = sourcePathForPreview;
      setHasChainedPreview(willChainPreview);
      setCutFadeSec(0);
      setCutMarkers(nextCutMarkers);
      setStagedEdit(edit);
      initialEditRef.current = null;
      setPreviewPath(path);
      setApplyMode(null);
    } catch (err) {
      setError(String(err));
      setApplyMode(null);
    }
  }

  async function handleApply() {
    if (!stagedEdit) return;
    stopShuttle();
    setApplyMode(stagedEdit.mode);
    setError(null);
    try {
      const result = hasChainedPreview && previewPath
        ? await invoke('commit_audio_preview', {
            inputPath: filePath,
            previewPath,
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
    setFadeInSec,
    fadeOutSec,
    setFadeOutSec,
    cutFadeSec,
    setCutFadeSec,
    applyMode,
    isApplying,
    isPreviewingEdit,
    fadeMax,
    outputFadeMax,
    cutFadeMax,
    canValidate,
    initialEditRef,
    undoStagedEdit,
    regenerateFadePreview,
    handleRestoreOriginal,
    handleStageAction,
    handleApply,
  };
}
