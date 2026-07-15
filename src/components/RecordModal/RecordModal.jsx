import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Mic } from '../icons/LucideLocal';
import { Button } from '../common/Button';
import { sanitizeProjectPrefix } from '../../utils/projectPrefix';
import './RecordModal.css';

const COUNTDOWN_SECONDS = 3;

export function RecordModal({ savePath, workspaceDir, projectName = '', onSaved, onClose }) {
  const [phase, setPhase] = useState('countdown'); // countdown | recording | preview | saving | error
  const [countdown, setCountdown] = useState(COUNTDOWN_SECONDS);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [recordingName, setRecordingName] = useState(() => {
    const prefix = sanitizeProjectPrefix(projectName);
    const stamp = Date.now();
    return prefix ? `${prefix}__rec_${stamp}` : `rec_${stamp}`;
  });

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const blobRef = useRef(null);
  const audioRef = useRef(null);
  const previewUrlRef = useRef(null);
  const timerRef = useRef(null);
  const closedRef = useRef(false);

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
      stream?.getTracks().forEach(track => track.stop());
      if (closedRef.current) return;
      setError(`Impossible d'accéder au micro : ${e.message}`);
      setPhase('error');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  function playPreview() {
    if (!blobRef.current) return;
    stopPreview();
    const url = URL.createObjectURL(blobRef.current);
    const a = new Audio(url);
    previewUrlRef.current = url;
    a.onended = () => {
      if (previewUrlRef.current === url) previewUrlRef.current = null;
      URL.revokeObjectURL(url);
    };
    a.play();
    audioRef.current = a;
  }

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  function retry() {
    stopPreview();
    blobRef.current = null;
    setDuration(0);
    setCountdown(COUNTDOWN_SECONDS);
    setPhase('countdown');
  }

  async function confirm() {
    if (!blobRef.current) return;
    setPhase('saving');
    try {
      const safeName = recordingName.trim().replace(/[<>:"/\\|?*\[\]+]/g, '_') || `rec_${Date.now()}`;
      const filename = safeName.endsWith('.webm') ? safeName : `${safeName}.webm`;
      const arrayBuffer = await blobRef.current.arrayBuffer();
      const data = Array.from(new Uint8Array(arrayBuffer));
      const path = await invoke('save_recording', { savePath, workspaceDir, filename, data });
      onSaved?.(path);
    } catch (e) {
      setError(`Écriture du fichier impossible : ${e}`);
      setPhase('error');
    }
  }

  function formatDuration(s) {
    return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box record-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Enregistrement audio</span>
          <Button variant="icon" className="modal-close" onClick={handleClose} disabled={phase === 'saving'}>×</Button>
        </div>

        <div className="record-body">
          {phase === 'countdown' && (
            <>
              <div className="record-countdown">{countdown}</div>
              <div className="record-hint">Prépare-toi…</div>
            </>
          )}

          {phase === 'recording' && (
            <>
              <div className="record-pulse" />
              <div className="record-timer">{formatDuration(duration)}</div>
              <Button variant="danger" onClick={stopRecording}>⏹ Arrêter</Button>
            </>
          )}

          {phase === 'preview' && (
            <>
              <div className="record-preview-icon">
                <Mic className="record-preview-icon-svg" strokeWidth={2} absoluteStrokeWidth />
              </div>
              <div className="record-hint">Durée : {formatDuration(duration)}</div>
              <div className="record-name-field">
                <input
                  className="record-name-input"
                  value={recordingName}
                  onChange={(e) => setRecordingName(e.target.value)}
                  placeholder="Nom du fichier"
                  spellCheck={false}
                />
                <span className="record-name-ext">.webm</span>
              </div>
              <div className="record-actions">
                <Button onClick={playPreview}>▶ Écouter</Button>
                <Button onClick={stopPreview}>⏸ Pause</Button>
                <Button onClick={retry}>↺ Recommencer</Button>
                <Button variant="primary" onClick={confirm}>✓ Utiliser</Button>
              </div>
            </>
          )}

          {phase === 'saving' && (
            <div className="record-hint">Écriture du fichier…</div>
          )}

          {phase === 'error' && (
            <>
              <div className="record-hint" style={{ color: '#E24B4A' }}>{error}</div>
              <Button onClick={handleClose}>Fermer</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
