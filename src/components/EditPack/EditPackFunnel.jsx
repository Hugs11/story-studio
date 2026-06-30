import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  FunnelShell,
  FunnelSectionHeader,
  FunnelDropZone,
  FunnelToolButton,
  FunnelGenerationState,
} from '../funnels';
import { Eye, FolderOpen, Package, TriangleAlert, Undo2, Upload } from '../icons/LucideLocal';
import { pickFolder, pickZip } from '../../hooks/useFileDialog';
import { basename } from '../../utils/fileUtils';

const ARCHIVE_RE = /\.(zip|7z)$/i;

/**
 * Funnel « Modifier un pack » (plan 04), monté sur le châssis (plan 03).
 * Enchaîne, sans quitter l'overlay : zone de dépôt (fichier/dossier) →
 * vérification d'éditabilité → décompression in-funnel → l'éditeur s'ouvre avec
 * le pack décompressé. Si non éditable : proposition de simulation.
 *
 * @param {Object}   props
 * @param {Function} props.onClose
 * @param {Function} props.onLand     async ({ zipPath, packLabel }) — session +
 *   extraction + atterrissage éditeur. Lève en cas d'échec.
 * @param {Function} props.onSimulate async ({ zipPath, packLabel }) — ouvre le
 *   simulateur (lecture seule).
 */
export function EditPackFunnel({ onClose, onLand, onSimulate }) {
  const [phase, setPhase] = useState('collect'); // collect | busy | readOnly | unsupported
  const [busy, setBusy] = useState({ title: '', hint: '' });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { zipPath, packLabel }

  async function processPack(path, kind) {
    if (!path) return;
    setError('');
    setBusy({ title: 'Vérification du pack…', hint: 'Un instant.' });
    setPhase('busy');
    try {
      const packLabel = basename(path);
      const isFolder = kind === 'folder' || (kind === 'auto' && !ARCHIVE_RE.test(path));
      const zipPath = isFolder
        ? await invoke('convert_folder_pack_to_zip', { folderPath: path })
        : path;
      const report = await invoke('classify_pack_editability', { zipPath });
      if (!report?.authoringEditable) {
        setPending({ zipPath, packLabel, report });
        setPhase(report?.readOnlyInspectable ? 'readOnly' : 'unsupported');
        return;
      }
      setBusy({ title: 'Décompression du pack…', hint: 'Ne ferme pas la fenêtre.' });
      await onLand({ zipPath, packLabel });
      onClose();
    } catch (e) {
      setError(`Ce pack n'a pas pu être ouvert : ${e?.message ?? e}`);
      setPhase('collect');
    }
  }

  const handleDrop = (paths) => processPack(paths?.[0], 'auto');
  const handleBrowseFile = async () => { const p = await pickZip(); if (p) processPack(p, 'file'); };
  const handleBrowseFolder = async () => { const p = await pickFolder(); if (p) processPack(p, 'folder'); };

  async function handleSimulate() {
    if (!pending) return;
    setBusy({ title: 'Préparation du simulateur…', hint: 'Un instant.' });
    setPhase('busy');
    try {
      await onSimulate(pending);
      onClose();
    } catch (e) {
      setError(`Le simulateur n'a pas pu s'ouvrir : ${e?.message ?? e}`);
      setPhase(pending?.report?.readOnlyInspectable ? 'readOnly' : 'unsupported');
    }
  }

  return (
    <FunnelShell
      icon={<Package />}
      title="Modifier un pack"
      onClose={onClose}
      showChrome={false}
      fitContent
      ariaLabel="Modifier un pack"
    >
      {phase === 'busy' && <FunnelGenerationState title={busy.title} hint={busy.hint} />}

      {phase === 'collect' && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<Upload />}
            title="Choisis un pack"
            description="Un .zip, un .7z ou un dossier d'histoire déjà décompressé."
          />
          <FunnelDropZone
            title="Dépose ton pack ici"
            hint="Formats : .zip, .7z ou dossier d'histoire décompressé"
            onFiles={handleDrop}
          >
            <FunnelToolButton icon={<Package />} accent="neutral" onClick={handleBrowseFile}>
              Importer zip/7z
            </FunnelToolButton>
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handleBrowseFolder}>
              Importer un dossier
            </FunnelToolButton>
          </FunnelDropZone>
          {error && <div className="funnel-error" role="alert">{error}</div>}
        </div>
      )}

      {phase === 'readOnly' && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<TriangleAlert />}
            title="Pack non éditable"
            description="Ce pack n'est pas éditable avec Story Studio. Tu peux quand même le simuler (lecture seule)."
          />
          {pending?.report?.reason && (
            <div className="funnel-error" role="status">{pending.report.reason}</div>
          )}
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            <FunnelToolButton icon={<Eye />} accent="violet" variant="solid" onClick={handleSimulate}>
              Simuler le pack
            </FunnelToolButton>
            <FunnelToolButton
              icon={<Undo2 />}
              accent="neutral"
              onClick={() => { setPending(null); setError(''); setPhase('collect'); }}
            >
              Choisir un autre pack
            </FunnelToolButton>
          </div>
        </div>
      )}

      {phase === 'unsupported' && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<TriangleAlert />}
            title="Pack non supporté"
            description="Ce pack ne peut pas être ouvert ni simulé par Story Studio."
          />
          {pending?.report?.reason && (
            <div className="funnel-error" role="status">{pending.report.reason}</div>
          )}
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            <FunnelToolButton
              icon={<Undo2 />}
              accent="neutral"
              onClick={() => { setPending(null); setError(''); setPhase('collect'); }}
            >
              Choisir un autre pack
            </FunnelToolButton>
          </div>
        </div>
      )}
    </FunnelShell>
  );
}
