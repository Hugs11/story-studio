import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pickZip } from '../../store/useFileDialog';
import './CentralPanel.css';
import './ImageField.css';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', webp: 'image/webp' };

function ZipCover({ zipPath, coverImage }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    if (!zipPath || !coverImage) { setUrl(null); return; }
    let cancelled = false;
    const assetName = `assets/${coverImage}`;
    invoke('get_pack_asset', { zipPath, assetName })
      .then(bytes => {
        if (cancelled) return;
        const ext = coverImage.split('.').pop().toLowerCase();
        const blob = new Blob([new Uint8Array(bytes)], { type: MIME[ext] || 'image/png' });
        setUrl(URL.createObjectURL(blob));
      })
      .catch(() => { if (!cancelled) setUrl(null); });
    return () => { cancelled = true; };
  }, [zipPath, coverImage]);

  if (!url) return null;
  return (
    <div className="image-field" style={{ marginBottom: 12, flex: 'none' }}>
      <div className="media-label">Vignette du pack</div>
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
      const name = picked.split(/[\\/]/).pop().replace(/\.(zip|7z)$/i, '');
      onUpdate({ zipPath: picked, name });
    }
  }

  const filename = node.zipPath ? node.zipPath.split(/[\\/]/).pop() : null;

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
        Cette archive est exclue du retraitement audio — elle sera intégrée telle quelle dans le pack final.
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn" style={{ color: '#E24B4A', borderColor: '#E24B4A' }} onClick={onDelete}>
          Supprimer cette archive
        </button>
      </div>
    </>
  );
}
