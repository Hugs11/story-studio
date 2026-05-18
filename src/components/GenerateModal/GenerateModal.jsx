import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { Loader2, CircleCheck, CircleX } from '../icons/LucideLocal';
import './GenerateModal.css';

function playNotification(type) {
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const notes = type === 'done'
      ? [{ f: 523, t: 0, d: 0.12 }, { f: 659, t: 0.13, d: 0.12 }, { f: 784, t: 0.26, d: 0.2 }]
      : [{ f: 400, t: 0, d: 0.15 }, { f: 280, t: 0.16, d: 0.25 }];

    notes.forEach(({ f, t, d }) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.connect(g);
      g.connect(ctx.destination);
      osc.type = type === 'done' ? 'sine' : 'sawtooth';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.18, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + d);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + d);
    });

    setTimeout(() => ctx.close(), 1500);
  } catch {}
}

export function GenerateModal({ onClose, promise }) {
  const [logs, setLogs] = useState([]);
  const [status, setStatus] = useState('running'); // running | done | error
  const [errorMsg, setErrorMsg] = useState('');
  const [copyStatus, setCopyStatus] = useState('idle');
  const logsEndRef = useRef(null);
  const copyResetRef = useRef(null);

  const fullLogText = [...logs, ...(status === 'error' && errorMsg ? [String(errorMsg)] : [])]
    .filter(Boolean)
    .join('\n');

  useEffect(() => {
    let unlisten;
    let stopped = false;

    listen('generate-log', (event) => {
      if (stopped) return;
      setLogs(prev => [...prev, event.payload]);
    }).then(fn => { unlisten = fn; });

    promise
      .then(() => { if (!stopped) setStatus('done'); })
      .catch(err => {
        if (!stopped) {
          setStatus('error');
          setErrorMsg(err);
        }
      });

    return () => {
      stopped = true;
      if (unlisten) unlisten();
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, [promise]);

  useEffect(() => {
    if (status === 'done' || status === 'error') playNotification(status);
  }, [status]);

  // Auto-scroll vers le bas
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  async function handleCopyLogs() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullLogText);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = fullLogText;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopyStatus('copied');
    } catch {
      setCopyStatus('error');
    }

    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopyStatus('idle'), 2000);
  }

  return (
    <div className="gen-overlay">
      <div className="gen-modal">
        <div className="gen-header">
          <span className="gen-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {status === 'running' && (
              <>
                <Loader2 style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} />
                Génération en cours...
              </>
            )}
            {status === 'done' && (
              <>
                <CircleCheck style={{ width: 16, height: 16, color: 'var(--color-success, #4caf50)' }} />
                Pack généré !
              </>
            )}
            {status === 'error' && (
              <>
                <CircleX style={{ width: 16, height: 16, color: 'var(--color-danger, #e24b4a)' }} />
                Erreur
              </>
            )}
          </span>
        </div>

        <div className="gen-log">
          <div className="gen-log-text">
            {logs.map((line, i) => (
              <div key={i} className="gen-log-line">{line}</div>
            ))}
            {status === 'error' && errorMsg && (
              <div className="gen-log-line gen-log-error">{errorMsg}</div>
            )}
          </div>
          <div ref={logsEndRef} />
        </div>

        <div className="gen-footer">
          {status === 'running' ? (
            <div className="gen-spinner" />
          ) : (
            <>
              <span className={`gen-copy-status ${copyStatus !== 'idle' ? 'is-visible' : ''}`}>
                {copyStatus === 'copied' && 'Logs copies'}
                {copyStatus === 'error' && 'Copie impossible'}
              </span>
              <button className="btn" onClick={handleCopyLogs}>
                Copier tous les logs
              </button>
              <button className="btn btn-primary" onClick={onClose}>Fermer</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
