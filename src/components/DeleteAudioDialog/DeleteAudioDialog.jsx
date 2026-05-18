import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import './DeleteAudioDialog.css';

const PREF_KEY = 'delete_audio_pref'; // 'app_only' | 'app_and_disk'
const DELETABLE_WORKSPACE_DIRS = ['fichiers-importes', 'enregistrements', 'voix-generees', 'images-generees'];

function isLikelyWorkspaceMediaFile(file, workspaceDir) {
  if (!file || !workspaceDir?.trim()) return false;
  const normalizedFile = String(file).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  const normalizedWorkspace = String(workspaceDir).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  return DELETABLE_WORKSPACE_DIRS.some((dir) => normalizedFile.startsWith(`${normalizedWorkspace}/${dir}/`));
}

export function DeleteAudioDialog({ file, workspaceDir = '', onDeleted, onClose, allowDiskDelete = true, diskDeleteHelp = null }) {
  const effectiveAllowDiskDelete = allowDiskDelete && isLikelyWorkspaceMediaFile(file, workspaceDir);
  const savedPref = localStorage.getItem(PREF_KEY);
  const effectiveSavedPref = effectiveAllowDiskDelete ? savedPref : (savedPref === 'app_only' ? savedPref : null);
  const [deleteFromDisk, setDeleteFromDisk] = useState(effectiveAllowDiskDelete && savedPref === 'app_and_disk');
  const [remember, setRemember] = useState(!!savedPref);
  const [error, setError] = useState('');
  const autoAppliedRef = useRef(false);

  useEffect(() => {
    if (!effectiveSavedPref || autoAppliedRef.current) return;
    autoAppliedRef.current = true;

    let cancelled = false;

    async function applySavedPreference() {
      if (effectiveSavedPref === 'app_and_disk' && file) {
        try {
          await invoke('delete_workspace_media_file', { path: file, workspaceDir });
        } catch (e) {
          if (!cancelled) {
            alert(`Suppression disque refusée : ${e}`);
            onDeleted();
          }
          return;
        }
      }
      if (!cancelled) onDeleted();
    }

    applySavedPreference();

    return () => {
      cancelled = true;
    };
  }, [effectiveSavedPref, file, onDeleted, workspaceDir]);

  useEscapeKey(!effectiveSavedPref, () => onClose?.());

  async function handleConfirm() {
    setError('');
    if (remember) {
      localStorage.setItem(PREF_KEY, deleteFromDisk ? 'app_and_disk' : 'app_only');
    } else {
      localStorage.removeItem(PREF_KEY);
    }
    if (deleteFromDisk && file) {
      try {
        await invoke('delete_workspace_media_file', { path: file, workspaceDir });
      } catch (e) {
        const message = `Suppression disque refusée : ${e}`;
        setError(message);
        alert(`${message}\n\nLa référence projet va être retirée, mais le fichier reste sur le disque.`);
        onDeleted();
        return;
      }
    }
    onDeleted();
  }

  // Si une préférence est mémorisée, on applique directement après montage.
  if (effectiveSavedPref) {
    return null;
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 340 }}>
        <div className="modal-header">
          <span>Supprimer l'audio</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="delete-dialog-body">
          <div className="delete-option" onClick={() => setDeleteFromDisk(false)}>
            <input type="radio" readOnly checked={!deleteFromDisk} />
            <div>
              <div className="delete-opt-label">Retirer du projet uniquement</div>
              <div className="delete-opt-sub">Le fichier reste sur le disque</div>
            </div>
          </div>
          {effectiveAllowDiskDelete ? (
            <div className="delete-option" onClick={() => setDeleteFromDisk(true)}>
              <input type="radio" readOnly checked={deleteFromDisk} />
              <div>
                <div className="delete-opt-label">Supprimer du projet et du disque</div>
                <div className="delete-opt-sub">Le fichier sera définitivement supprimé</div>
              </div>
            </div>
          ) : (
            <div className="info-box" style={{ marginTop: 12 }}>
              {diskDeleteHelp || "Ce fichier n'est pas dans l'emplacement de travail Story Studio. Il sera seulement retiré de Story Studio."}
            </div>
          )}

          <label className="delete-remember">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            Se souvenir de ce choix
          </label>

          {error && (
            <div className="info-box warn" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div className="delete-dialog-footer">
          <button className="btn" onClick={onClose}>Annuler</button>
          <button className="btn btn-danger" onClick={handleConfirm}>Supprimer</button>
        </div>
      </div>
    </div>
  );
}

// Réinitialise la préférence mémorisée (appelable depuis les Options si besoin)
export function resetDeleteAudioPref() {
  localStorage.removeItem(PREF_KEY);
}
