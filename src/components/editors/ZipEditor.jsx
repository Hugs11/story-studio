import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { pickFolder, pickZip } from '../../hooks/useFileDialog';
import { useProjectContext } from '../../store/ProjectContext';
import { presentUserMessage } from '../../i18n/userMessage.js';
import { basename } from '../../utils/fileUtils';
import { Button } from '../common/Button';
import { useZipCover } from './useZipCover.js';
import './EditorPanel.css';
import './ImageField.css';

function ZipCover({ zipPath, coverImage }) {
  const { t } = useTranslation('tree');
  // useZipCover gere le chargement de l'asset + la revocation de l'object URL
  // (l'ancienne implementation locale ne revoquait jamais -> fuite memoire).
  const url = useZipCover(zipPath, coverImage);

  if (!url) return null;
  return (
    <div className="image-field" style={{ marginBottom: 12, flex: 'none' }}>
      <div className="media-label">{t("tree:zip.cover.label")}</div>
      {/* Aperçu en lecture seule : le cadre du champ image, sans barre
          d'outils — d'où `--bare`, qui ne réserve pas sa gouttière. */}
      <div className="image-slot image-slot--bare">
        <div className="image-slot__frame">
          <div className="image-drop filled" style={{ cursor: 'default' }}>
            <img src={url} alt="" className="image-preview" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function ZipEditor({ node, onUpdate, onDelete }) {
  const { t } = useTranslation('tree');
  const { onKeepFolderPack, mediaStorage } = useProjectContext();
  const [folderError, setFolderError] = useState('');
  // La conversion est longue : son résultat ne vaut que si ce nœud est encore là.
  const liveNodeRef = useRef(null);
  liveNodeRef.current = {
    id: node.id, workId: mediaStorage?.storage?.workId,
    root: mediaStorage?.root, ephemeral: mediaStorage?.ephemeral,
    folder: mediaStorage?.storage?.folder,
  };
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  async function handlePick() {
    const picked = await pickZip();
    setFolderError('');
    if (picked) {
      const name = basename(picked).replace(/\.(zip|7z)$/i, '');
      onUpdate({ zipPath: picked, name });
    }
  }

  // Un dossier de pack vaut une archive : converti par le lecteur unique du moteur.
  async function handlePickFolder() {
    const nodeId = node.id;
    const workId = mediaStorage?.storage?.workId;
    const stillHere = () => mountedRef.current && liveNodeRef.current.id === nodeId
      && liveNodeRef.current.workId === workId
      && liveNodeRef.current.root === mediaStorage?.root
      && liveNodeRef.current.ephemeral === mediaStorage?.ephemeral
      && (mediaStorage?.ephemeral || liveNodeRef.current.folder === mediaStorage?.storage?.folder);
    const folder = await pickFolder();
    if (!folder || !stillHere()) return;
    try {
      await onKeepFolderPack(folder, {
        destination: mediaStorage,
        isCurrent: stillHere,
        apply: zipPath => onUpdate({ zipPath, name: basename(folder) }),
      });
    } catch (e) {
      if (stillHere()) setFolderError(presentUserMessage(e).message);
    }
  }

  const filename = node.zipPath ? basename(node.zipPath) : null;

  return (
    <>
      {node.coverImage && <ZipCover zipPath={node.zipPath} coverImage={node.coverImage} />}
      <div className="card">
        <div className="card-title">{t("tree:zip.card.title")}</div>
        <div className="field-row">
          <span className="field-label">{t("tree:zip.name.label")}</span>
          <input
            className="field-input"
            value={node.name || ''}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder={t("tree:zip.name.placeholder")}
          />
        </div>
        <div className="field-row">
          <span className="field-label">{t("tree:zip.file.label")}</span>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {filename || t("tree:zip.file.empty")}
          </span>
          <Button size="sm" onClick={handlePick}>
            {filename ? t("tree:zip.file.replace") : t("tree:zip.file.choose")}
          </Button>
          <Button size="sm" onClick={handlePickFolder}>{t("tree:zip.folder.choose")}</Button>
        </div>
        {folderError && <div className="info-box warn" role="alert">{folderError}</div>}
      </div>

      <div className="info-box warn">{t("tree:zip.export.notice")}</div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="danger-outline" onClick={onDelete}>{t("tree:zip.delete.action")}</Button>
      </div>
    </>
  );
}
