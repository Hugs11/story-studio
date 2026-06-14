import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { useErrorDialog } from '../common/Dialog';
import { AppModalPortal } from '../common/AppModalPortal';
import { Button } from '../common/Button';
import {
  ENREGISTREMENTS,
  FICHIERS_IMPORTES,
  IMAGES_GENEREES,
  VOIX_GENEREES,
} from '../../store/workspaceDirs';
import './DeleteAudioDialog.css';

const DELETABLE_WORKSPACE_DIRS = [FICHIERS_IMPORTES, ENREGISTREMENTS, VOIX_GENEREES, IMAGES_GENEREES];

function isLikelyWorkspaceMediaFile(file, workspaceDir) {
  if (!file || !workspaceDir?.trim()) return false;
  const normalizedFile = String(file).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  const normalizedWorkspace = String(workspaceDir).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  return DELETABLE_WORKSPACE_DIRS.some((dir) => normalizedFile.startsWith(`${normalizedWorkspace}/${dir}/`));
}

export function DeleteAudioDialog({ file, workspaceDir = '', onDeleted, onClose, allowDiskDelete = true, diskDeleteHelp = null }) {
  const { showErrorDialog } = useErrorDialog();
  const effectiveAllowDiskDelete = allowDiskDelete && isLikelyWorkspaceMediaFile(file, workspaceDir);
  const [deleteFromDisk, setDeleteFromDisk] = useState(false);
  const [error, setError] = useState('');

  useEscapeKey(true, () => onClose?.());

  async function handleConfirm() {
    setError('');
    if (deleteFromDisk && file) {
      try {
        await invoke('delete_workspace_media_file', { path: file, workspaceDir });
      } catch (e) {
        const message = `Suppression disque refusée : ${e}`;
        setError(message);
        showErrorDialog({
          title: 'Suppression disque refusée',
          message: `${message}\n\nLa référence projet va être retirée, mais le fichier reste sur le disque.`,
          variant: 'warning',
        });
        onDeleted();
        return;
      }
    }
    onDeleted();
  }

  return (
    <AppModalPortal className="delete-audio-overlay">
      <div className="modal-box" onClick={e => e.stopPropagation()} style={{ width: 340 }}>
        <div className="modal-header">
          <span>Supprimer l'audio</span>
          <Button variant="icon" className="modal-close" onClick={onClose}>×</Button>
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

          {error && (
            <div className="info-box warn" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div className="delete-dialog-footer">
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="danger" onClick={handleConfirm}>Supprimer</Button>
        </div>
      </div>
    </AppModalPortal>
  );
}
