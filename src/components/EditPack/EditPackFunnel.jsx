import { useEffect, useRef, useState } from 'react';
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
import { KEYS, read as readSetting } from '../../store/persistentSettings';
import {
  createEditPackOperationLifecycle,
  runEditPackImportOperation,
} from './editPackOperationLifecycle';

const ARCHIVE_RE = /\.(zip|7z)$/i;

/**
 * Funnel « Modifier un pack », monté sur le châssis commun des funnels.
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
  const allowUnsupportedExtraction = readSetting(KEYS.ALLOW_UNSUPPORTED_PACK_EXTRACTION) === 'true';
  const operationLifecycleRef = useRef(null);
  if (!operationLifecycleRef.current) {
    operationLifecycleRef.current = createEditPackOperationLifecycle();
  }

  useEffect(() => {
    operationLifecycleRef.current.activate();
    return () => operationLifecycleRef.current.deactivate();
  }, []);

  function closeFunnel() {
    operationLifecycleRef.current.deactivate();
    onClose();
  }

  function handleClose() {
    if (operationLifecycleRef.current.isRunning()) return;
    closeFunnel();
  }

  async function processPack(path, kind) {
    const operation = operationLifecycleRef.current;
    if (!path || !operation.isActive()) return;
    setError('');
    setBusy({ title: 'Vérification du pack…', hint: 'Un instant.' });
    setPhase('busy');
    const packLabel = basename(path);
    const isFolder = kind === 'folder' || (kind === 'auto' && !ARCHIVE_RE.test(path));
    const result = await runEditPackImportOperation({
      lifecycle: operation,
      path,
      isFolder,
      convertFolder: (folderPath) => invoke('convert_folder_pack_to_zip', { folderPath }),
      classify: (zipPath) => invoke('classify_pack_editability', { zipPath }),
      beforeLand: () => {
        setBusy({ title: 'Décompression du pack…', hint: 'Ne ferme pas la fenêtre.' });
      },
      land: (zipPath) => onLand({ zipPath, packLabel }),
    });
    if (result.status === 'landed') {
      closeFunnel();
    } else if (result.status === 'classified') {
      setPending({ zipPath: result.zipPath, packLabel, report: result.report });
      setPhase(result.report?.readOnlyInspectable ? 'readOnly' : 'unsupported');
    } else if (result.status === 'error') {
      setError(`Ce pack n'a pas pu être ouvert : ${result.error?.message ?? result.error}`);
      setPhase('collect');
    }
  }

  const handleDrop = (paths) => processPack(paths?.[0], 'auto');
  const handleBrowseFile = async () => {
    const operation = operationLifecycleRef.current;
    const session = operation.captureSession();
    const path = await pickZip();
    if (path && operation.isSessionCurrent(session)) processPack(path, 'file');
  };
  const handleBrowseFolder = async () => {
    const operation = operationLifecycleRef.current;
    const session = operation.captureSession();
    const path = await pickFolder();
    if (path && operation.isSessionCurrent(session)) processPack(path, 'folder');
  };

  async function handleSimulate() {
    if (!pending) return;
    const operation = operationLifecycleRef.current;
    const token = operation.begin();
    if (token === null) return;
    setBusy({ title: 'Préparation du simulateur…', hint: 'Un instant.' });
    setPhase('busy');
    try {
      if (!operation.claimCompletion(token)) return;
      await onSimulate(pending);
      if (!operation.isCurrent(token)) return;
      operation.finish(token);
      closeFunnel();
    } catch (e) {
      if (!operation.isCurrent(token)) return;
      operation.finish(token);
      setError(`Le simulateur n'a pas pu s'ouvrir : ${e?.message ?? e}`);
      setPhase(pending?.report?.readOnlyInspectable ? 'readOnly' : 'unsupported');
    }
  }

  async function handleForceExtract() {
    if (!pending || !allowUnsupportedExtraction) return;
    const operation = operationLifecycleRef.current;
    const token = operation.begin();
    if (token === null) return;
    setBusy({ title: 'Extraction forcée du pack…', hint: 'La structure récupérée peut être incomplète.' });
    setPhase('busy');
    try {
      if (!operation.claimCompletion(token)) return;
      await onLand({ ...pending, allowUnsupported: true });
      if (!operation.isCurrent(token)) return;
      operation.finish(token);
      closeFunnel();
    } catch (e) {
      if (!operation.isCurrent(token)) return;
      operation.finish(token);
      setError(`L’extraction forcée a échoué : ${e?.message ?? e}`);
      setPhase(pending?.report?.readOnlyInspectable ? 'readOnly' : 'unsupported');
    }
  }

  return (
    <FunnelShell
      icon={<Package />}
      title="Modifier un pack"
      onClose={handleClose}
      closeDisabled={phase === 'busy'}
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
            description={allowUnsupportedExtraction
              ? "Ce pack n'est pas éditable de manière fiable. Tu peux le simuler ou tenter une extraction incomplète."
              : "Ce pack n'est pas éditable avec Story Studio. Tu peux quand même le simuler (lecture seule)."}
          />
          {pending?.report?.reason && (
            <div className="funnel-error" role="status">{pending.report.reason}</div>
          )}
          {!allowUnsupportedExtraction && (
            <div className="funnel-warning" role="status">
              Besoin de récupérer des éléments ? Une option avancée permet de tenter l’extraction :
              {' '}Préférences → Avancé → Import et audio. La structure obtenue peut être incomplète.
            </div>
          )}
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            {allowUnsupportedExtraction && (
              <FunnelToolButton icon={<TriangleAlert />} accent="neutral" onClick={handleForceExtract}>
                Extraire quand même
              </FunnelToolButton>
            )}
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
            description={allowUnsupportedExtraction
              ? "Ce pack ne peut pas être ouvert normalement. Tu peux tenter une extraction incomplète pour récupérer ses éléments."
              : "Ce pack ne peut pas être ouvert ni simulé par Story Studio."}
          />
          {pending?.report?.reason && (
            <div className="funnel-error" role="status">{pending.report.reason}</div>
          )}
          {!allowUnsupportedExtraction && (
            <div className="funnel-warning" role="status">
              Besoin de récupérer des éléments ? Une option avancée permet de tenter l’extraction :
              {' '}Préférences → Avancé → Import et audio. La structure obtenue peut être incomplète.
            </div>
          )}
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            {allowUnsupportedExtraction && (
              <FunnelToolButton icon={<TriangleAlert />} accent="neutral" onClick={handleForceExtract}>
                Tenter l’extraction
              </FunnelToolButton>
            )}
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
