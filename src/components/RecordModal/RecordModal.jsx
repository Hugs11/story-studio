import { presentStoredError } from '../../i18n/userMessage.js';
import { presentMedia } from '../../i18n/mediaPresentation.js';
import { useMediaTranslation } from '../../i18n/useMediaTranslation.js';
import { useProjectContext } from '../../store/ProjectContext';
import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Mic } from '../icons/LucideLocal';
import { Button } from '../common/Button';
import { beginProjectMediaOutput } from '../../store/projectMediaOutput';
import { createAudioPlayer, disposeAudioPlayerRef } from '../../utils/audioPlayer';
import './RecordModal.css';

const COUNTDOWN_SECONDS = 3;

export function RecordModal({ workspaceDir, onSaved, onClose }) {
  const { t } = useMediaTranslation();
  const { mediaStorage } = useProjectContext();
  const [phase, setPhase] = useState('countdown'); // countdown | recording | preview | saving | error
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [previewStatus, setPreviewStatus] = useState('idle');
  const [previewPosition, setPreviewPosition] = useState(0);
  const [previewError, setPreviewError] = useState(null);
  const [recordingName, setRecordingName] = useState(() => {
    return `rec_${Date.now()}`;
  });

  const mediaRecorderRef = useRef(null);
  const mediaOutputRef = useRef(null);
  const chunksRef = useRef([]);
  const blobRef = useRef(null);
  const audioRef = useRef(null);
  const timerRef = useRef(null);
  const closedRef = useRef(false);
  const savingRef = useRef(false);

  // Countdown → démarrage enregistrement
  useEffect(() => {
    if (phase !== 'countdown') return;
    if (countdown === 0) {
      startRecording();
      return;
    }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, countdown]);

  // Timer durée enregistrement
  useEffect(() => {
    if (phase !== 'recording') return;
    timerRef.current = setInterval(() => setDuration(d => d + 1), 1000);
    return () => clearInterval(timerRef.current);
  }, [phase]);

  useEffect(() => {
    // React StrictMode simule un démontage/remontage en développement : chaque
    // montage doit réarmer explicitement la demande micro.
    closedRef.current = false;
    return () => {
      closedRef.current = true;
      if (!savingRef.current) mediaOutputRef.current?.release();
      releaseRecording();
      stopPreview();
    };
  }, []);

  // Pendant l'écriture, Escape reste capturé par cette modale mais ne la ferme
  // pas : il ne doit pas atteindre une surface située dessous.
  useEscapeKey(true, handleClose);

  function handleClose() {
    if (phase === 'saving') return;
    closedRef.current = true;
    mediaOutputRef.current?.release();
    releaseRecording();
    stopPreview();
    onClose?.();
  }

  function releaseRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
    recorder.stream?.getTracks().forEach(track => track.stop());
    mediaRecorderRef.current = null;
  }

  async function startRecording() {
    let stream = null;
    try {
      mediaOutputRef.current?.release();
      mediaOutputRef.current = beginProjectMediaOutput(mediaStorage ?? { root: workspaceDir, ephemeral: true });
      await mediaOutputRef.current.arguments();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (closedRef.current) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        if (mediaRecorderRef.current === mr) mediaRecorderRef.current = null;
        if (closedRef.current) return;
        blobRef.current = new Blob(chunksRef.current, { type: 'audio/webm' });
        setPhase('preview');
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setPhase('recording');
    } catch (e) {
      mediaOutputRef.current?.release();
      stream?.getTracks().forEach(track => track.stop());
      if (closedRef.current) return;
      // Descripteur : la cause technique du navigateur reste un paramètre brut.
      setError({ key: 'media:record.microphone.failed', params: { detail: e.message } });
      setPhase('error');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  function playPreview() {
    if (!blobRef.current) return;
    setPreviewError(null);
    try {
      let a = audioRef.current;
      if (!a) {
        const url = URL.createObjectURL(blobRef.current);
        try {
          a = createAudioPlayer(url, { revokeSourceOnDestroy: true });
        } catch (e) {
          URL.revokeObjectURL(url);
          throw e;
        }
        a.onplay = () => setPreviewStatus('playing');
        a.onpause = () => setPreviewStatus('paused');
        a.ontimeupdate = () => setPreviewPosition(a.currentTime);
        a.onended = () => {
          if (audioRef.current !== a) return;
          stopPreview();
          setPreviewPosition(duration);
          setPreviewStatus('ended');
        };
        audioRef.current = a;
      }
      setPreviewStatus('loading');
      a.play().catch(e => {
        if (audioRef.current !== a) return;
        stopPreview();
        setPreviewStatus('error');
        setPreviewError({ key: 'media:record.preview.failed', params: { detail: e.message } });
      });
    } catch (e) {
      stopPreview();
      setPreviewStatus('error');
      setPreviewError({ key: 'media:record.preview.failed', params: { detail: e.message } });
    }
  }

  function pausePreview() {
    audioRef.current?.pause();
  }

  function stopPreview() {
    disposeAudioPlayerRef(audioRef);
  }

  function retry() {
    stopPreview();
    blobRef.current = null;
    setDuration(0);
    setPreviewPosition(0);
    setPreviewStatus('idle');
    setPreviewError(null);
    setCountdown(COUNTDOWN_SECONDS);
    setPhase('countdown');
  }

  async function confirm() {
    if (!blobRef.current) return;
    stopPreview();
    setPhase('saving');
    savingRef.current = true;
    const output = mediaOutputRef.current;
    try {
      const safeName = recordingName.trim().replace(/[<>:"/\\|?*\[\]+]/g, '_') || `rec_${Date.now()}`;
      const filename = safeName.endsWith('.webm') ? safeName : `${safeName}.webm`;
      const arrayBuffer = await blobRef.current.arrayBuffer();
      const data = Array.from(new Uint8Array(arrayBuffer));
      const path = await invoke('save_recording', { ...await output.arguments(), filename, data });
      if (!closedRef.current) onSaved?.(path);
    } catch (e) {
      if (!closedRef.current) {
        setError({ userMessage: e, prefix: { key: 'media:record.write.failedPrefix' } });
        setPhase('error');
      }
    } finally {
      savingRef.current = false;
      output?.release();
    }
  }

  function formatDuration(s) {
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box record-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{t('media:record.title')}</span>
          <Button variant="icon" className="modal-close" onClick={handleClose} disabled={phase === 'saving'}>×</Button>
        </div>

        <div className="record-body">
          {phase === 'countdown' && (
            <>
              <div className="record-countdown">{countdown}</div>
              <div className="record-hint">{t('media:record.countdown.hint')}</div>
            </>
          )}

          {phase === 'recording' && (
            <>
              <div className="record-pulse" />
              <div className="record-timer">{formatDuration(duration)}</div>
              <Button variant="danger" onClick={stopRecording}>{t('media:record.stop.action')}</Button>
            </>
          )}

          {phase === 'preview' && (
            <>
              <div className="record-preview-icon">
                <Mic className="record-preview-icon-svg" strokeWidth={2} absoluteStrokeWidth />
              </div>
              <div className="record-hint">{t('media:record.duration.label', { duration: formatDuration(duration) })}</div>
              {previewStatus !== 'idle' && previewStatus !== 'error' && (
                <div className="record-hint" role="status">
                  {previewStatus === 'loading' && t('media:record.preview.loading')}
                  {previewStatus === 'playing' && t('media:record.preview.playing', { position: formatDuration(Math.floor(previewPosition)), duration: formatDuration(duration) })}
                  {previewStatus === 'paused' && t('media:record.preview.paused', { position: formatDuration(Math.floor(previewPosition)) })}
                  {previewStatus === 'ended' && t('media:record.preview.ended')}
                </div>
              )}
              {previewError && <div className="record-hint" role="alert" style={{ color: '#E24B4A' }}>{presentMedia(previewError)}</div>}
              <div className="record-name-field">
                <input
                  className="record-name-input"
                  value={recordingName}
                  onChange={(e) => setRecordingName(e.target.value)}
                  placeholder={t('media:record.name.placeholder')}
                  spellCheck={false}
                />
                <span className="record-name-ext">.webm</span>
              </div>
              <div className="record-actions">
                <Button onClick={playPreview} disabled={previewStatus === 'loading' || previewStatus === 'playing'}>
                  {previewStatus === 'paused' ? t('media:record.preview.resume') : t('media:record.preview.listen')}
                </Button>
                <Button onClick={pausePreview} disabled={previewStatus !== 'playing'}>{t('media:record.preview.pause')}</Button>
                <Button onClick={retry}>{t('media:record.retry.action')}</Button>
                <Button variant="primary" onClick={confirm}>{t('media:record.use.action')}</Button>
              </div>
            </>
          )}

          {phase === 'saving' && (
            <div className="record-hint">{t('media:record.saving.progress')}</div>
          )}

          {phase === 'error' && (
            <>
              <div className="record-hint" style={{ color: '#E24B4A' }}>{presentStoredError(error)}</div>
              <Button onClick={handleClose}>{t('common:dialog.close.label')}</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
