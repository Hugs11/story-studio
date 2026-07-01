import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { Mic } from '../icons/LucideLocal';
import { Button } from '../common/Button';
import { sanitizeProjectPrefix } from '../../utils/projectPrefix';
import './RecordModal.css';

const COUNTDOWN_SECONDS = 3;

export function RecordModal({ savePath, workspaceDir, projectName = '', onSaved, onClose }) {
  const [phase, setPhase] = useState('countdown'); // countdown | recording | preview | saving
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
  const timerRef = useRef(null);

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

  useEscapeKey(true, () => onClose?.());

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      mr.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        blobRef.current = new Blob(chunksRef.current, { type: 'audio/webm' });
        setPhase('preview');
      };
      mr.start();
      mediaRecorderRef.current = mr;
      setPhase('recording');
    } catch (e) {
      setError(`Impossible d'accéder au micro : ${e.message}`);
      setPhase('error');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
  }

  function playPreview() {
    if (!blobRef.current) return;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    const url = URL.createObjectURL(blobRef.current);
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    a.play();
    audioRef.current = a;
  }

  function stopPreview() {
    audioRef.current?.pause();
    audioRef.current = null;
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
      onSaved(path);
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
          <Button variant="icon" className="modal-close" onClick={onClose}>×</Button>
        </div>

        <div className="record-body">
          {phase === 'countdown' && (
            <>
              <div className="record-countdown">{countdown}</div>
              <div className="record-hint">Préparez-vous…</div>
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
              <Button onClick={onClose}>Fermer</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
