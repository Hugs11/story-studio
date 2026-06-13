import { pickZip } from '../../hooks/useFileDialog';
import { basename } from '../../utils/fileUtils';
import { useZipCover } from './useZipCover.js';
import './CentralPanel.css';
import './ImageField.css';

function ZipCover({ zipPath, coverImage }) {
  // useZipCover gere le chargement de l'asset + la revocation de l'object URL
  // (l'ancienne implementation locale ne revoquait jamais -> fuite memoire).
  const url = useZipCover(zipPath, coverImage);

  if (!url) return null;
  return (
    <div className="image-field" style={{ marginBottom: 12, flex: 'none' }}>
      <div className="media-label">Vignette catalogue</div>
      <div className="image-drop filled" style={{ cursor: 'default' }}>
        <img src={url} alt="" className="image-preview" />
      </div>
    </div>
  );
}

export function ZipEditor({ node, onUpdate, onDelete }) {
  async function handlePick() {
    const picked = await pickZip();
    if (picked) {
      const name = basename(picked).replace(/\.(zip|7z)$/i, '');
      onUpdate({ zipPath: picked, name });
    }
  }

  const filename = node.zipPath ? basename(node.zipPath) : null;

  return (
    <>
      {node.coverImage && <ZipCover zipPath={node.zipPath} coverImage={node.coverImage} />}
      <div className="card">
        <div className="card-title">Informations</div>
        <div className="field-row">
          <span className="field-label">Nom</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="Nom affiché"
          />
        </div>
        <div className="field-row">
          <span className="field-label">Fichier</span>
          <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {filename || 'Aucun fichier'}
          </span>
          <button className="btn-xs" onClick={handlePick}>
            {filename ? 'Remplacer' : 'Choisir'}
          </button>
        </div>
      </div>

      <div className="info-box warn">
        Ce pack sera inclus tel quel dans l'export final, sans modifications audio.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-danger-outline" onClick={onDelete}>
          Supprimer cette archive
        </button>
      </div>
    </>
  );
}
