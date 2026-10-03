import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  FunnelShell,
  FunnelSectionHeader,
  FunnelDropZone,
  FunnelToolButton,
  FunnelGenerationState,
} from '../funnels';
import { Eye, FolderOpen, Package, TriangleAlert, Undo2, Upload } from '../icons/LucideLocal';
import { useErrorDialog } from '../common/Dialog';
import { pickFolder, pickZip } from '../../hooks/useFileDialog';
import { basename } from '../../utils/fileUtils';
import {
  createEditPackOperationLifecycle,
  editorChooserFor,
  runEditPackBundleChildOperation,
  runEditPackImportOperation,
} from './editPackOperationLifecycle';
import { BundleChildStep } from './BundleChildStep';
import { inspectionProgressRatio } from './bundleChildren';
import { graphOnlyNoticeFor } from './graphOnlyNotice';
import { ImportErrorNotice } from './ImportErrorNotice';
import { presentImportError } from './importErrorPresentation';
import { releaseTauriListener } from '../../utils/tauriListener';

const ARCHIVE_RE = /\.(zip|7z)$/i;

/// Avancement de l'examen d'une archive enveloppe. L'évènement ne porte que des
/// comptes : aucun nom de pack d'une bibliothèque privée n'y circule.
const BUNDLE_PROGRESS_EVENT = 'pack-bundle-inspection-progress';

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
 * @param {Function} props.onLandAdvanced async ({ zipPath, packLabel }) — ouvre
 *   le pack dans l'Éditeur graphe. Après classement, un pack compatible avec
 *   les deux éditeurs laisse le choix ; un pack non fidèle au Libre ouvre le
 *   Graphe directement.
 * @param {Function} props.onBeforeReplace async () — garde de sauvegarde du
 *   projet courant, appelée seulement quand le pack et l'éditeur sont connus.
 * @param {boolean}  props.openedFromGraph ouvert depuis l'Éditeur graphe : un
 *   pack compatible avec les deux éditeurs s'ouvre dans le Graphe sans question.
 * @param {Function} props.onNotice (texte) — notice affichée à l'atterrissage quand
 *   un pack ne s'ouvre que dans le Graphe et que l'auteur ne l'avait pas choisi.
 */
export function EditPackFunnel({
  onClose,
  onLand,
  onSimulate,
  onLandAdvanced = null,
  onBeforeReplace = async () => true,
  openedFromGraph = false,
  onNotice = null,
}) {
  const { showChoiceDialog } = useErrorDialog();
  // collect | busy | bundle | readOnly | unsupported
  const [phase, setPhase] = useState('collect');
  const [busy, setBusy] = useState({ title: '', hint: '' });
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null); // { zipPath, packLabel }
  // L'enveloppe ouverte, tant que l'auteur n'en est pas sorti : revenir depuis
  // un verdict le ramène à sa liste, pas à la zone de dépôt.
  const [bundle, setBundle] = useState(null);
  const [selectedChildId, setSelectedChildId] = useState(null);
  // L'éditeur d'origine est celui de l'ouverture : l'atterrissage change le
  // projet courant, pas la question déjà tranchée.
  const [fromGraph] = useState(openedFromGraph);
  const operationLifecycleRef = useRef(null);
  if (!operationLifecycleRef.current) {
    operationLifecycleRef.current = createEditPackOperationLifecycle();
  }

  useEffect(() => {
    operationLifecycleRef.current.activate();
    return () => operationLifecycleRef.current.deactivate();
  }, []);

  // L'examen d'une enveloppe classe chacun de ses packs : sur une grosse
  // archive cela dure, donc l'avancement s'affiche au lieu d'un spinner muet.
  useEffect(() => {
    let disposed = false;
    let stop = null;
    listen(BUNDLE_PROGRESS_EVENT, (event) => {
      if (disposed) return;
      setProgress(inspectionProgressRatio(event?.payload?.done, event?.payload?.total));
    }).then((unlisten) => {
      if (disposed) releaseTauriListener(unlisten);
      else stop = unlisten;
    }).catch(() => {});
    return () => {
      disposed = true;
      releaseTauriListener(stop);
    };
  }, []);

  function closeFunnel() {
    operationLifecycleRef.current.deactivate();
    onClose();
  }

  function handleClose() {
    if (operationLifecycleRef.current.isRunning()) return;
    closeFunnel();
  }

  // La suite d'un atterrissage, identique qu'il vienne d'un pack déposé seul ou
  // d'un enfant choisi dans une enveloppe.
  function applyImportResult(result, packLabel, fallbackPhase) {
    setProgress(null);
    if (result.status === 'landed') {
      const notice = graphOnlyNoticeFor(result, { openedFromGraph: fromGraph });
      if (notice) onNotice?.(notice);
      closeFunnel();
    } else if (result.status === 'choice-cancelled') {
      setPhase(fallbackPhase);
    } else if (result.status === 'classified') {
      setPending({
        zipPath: result.zipPath,
        packLabel,
        report: result.report,
        advancedError: result.advancedError ?? null,
      });
      setPhase(result.report?.readOnlyInspectable ? 'readOnly' : 'unsupported');
    } else if (result.status === 'error') {
      setError(presentImportError(result.error));
      setPhase(fallbackPhase);
    }
  }

  async function processPack(path, kind) {
    const operation = operationLifecycleRef.current;
    if (!path || !operation.isActive()) return;
    setError('');
    setProgress(null);
    // Ouvrir un autre pack efface la notice du précédent, avant l'atterrissage :
    // celles que l'atterrissage pose lui-même arrivent après.
    onNotice?.(null);
    // Une nouvelle archive quitte définitivement l'enveloppe précédente : sans
    // cela, un retour depuis un verdict ramènerait à une liste qui n'est plus
    // celle de l'archive ouverte.
    setBundle(null);
    setSelectedChildId(null);
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
      inspect: (archivePath) => invoke('inspect_pack_archive', { path: archivePath }),
      beforeInspect: () => {
        setBusy({
          title: 'Examen de l’archive…',
          hint: 'Si elle contient plusieurs packs, ils sont examinés un par un.',
        });
      },
      beforeLand: (editor) => {
        setBusy({
          title: editor === 'advanced'
            ? 'Ouverture de l’Éditeur graphe…'
            : 'Décompression du pack…',
          hint: 'Ne ferme pas la fenêtre.',
        });
      },
      land: (zipPath) => onLand({ zipPath, packLabel }),
      landAdvanced: onLandAdvanced ? (zipPath) => onLandAdvanced({ zipPath, packLabel }) : null,
      chooseEditor: onLandAdvanced ? editorChooser : null,
      beforeReplace: onBeforeReplace,
    });
    if (result.status === 'bundle') {
      setProgress(null);
      setBundle({
        containerPath: result.containerPath,
        containerLabel: packLabel,
        containerFingerprint: result.inspection.containerFingerprint,
        children: result.inspection.children,
      });
      setSelectedChildId(null);
      setPhase('bundle');
      return;
    }
    applyImportResult(result, packLabel, 'collect');
  }

  // L'enfant choisi reprend le parcours d'import d'un pack normal, sans le
  // modifier : même classification, même éditeur, même simulation.
  async function processBundleChild() {
    if (!bundle || !selectedChildId) return;
    const operation = operationLifecycleRef.current;
    const child = bundle.children.find((entry) => entry.childId === selectedChildId);
    const packLabel = child?.displayName ?? bundle.containerLabel;
    setError('');
    setProgress(null);
    onNotice?.(null);
    setBusy({ title: 'Préparation du pack choisi…', hint: 'Ne ferme pas la fenêtre.' });
    setPhase('busy');
    const result = await runEditPackBundleChildOperation({
      lifecycle: operation,
      containerPath: bundle.containerPath,
      containerFingerprint: bundle.containerFingerprint,
      childId: selectedChildId,
      extractChild: ({ containerPath, containerFingerprint, childId }) => invoke(
        'extract_pack_bundle_child',
        { path: containerPath, containerFingerprint, childId },
      ),
      classify: (zipPath) => invoke('classify_pack_editability', { zipPath }),
      beforeLand: (editor) => {
        setBusy({
          title: editor === 'advanced'
            ? 'Ouverture de l’Éditeur graphe…'
            : 'Décompression du pack…',
          hint: 'Ne ferme pas la fenêtre.',
        });
      },
      land: (zipPath) => onLand({ zipPath, packLabel }),
      landAdvanced: onLandAdvanced ? (zipPath) => onLandAdvanced({ zipPath, packLabel }) : null,
      chooseEditor: onLandAdvanced ? editorChooser : null,
      beforeReplace: onBeforeReplace,
    });
    applyImportResult(result, packLabel, 'bundle');
  }

  // Revenir depuis un verdict ramène à la liste de l'enveloppe quand on en
  // vient, et à la zone de dépôt sinon.
  function backFromVerdict() {
    setPending(null);
    setError('');
    setPhase(bundle ? 'bundle' : 'collect');
  }

  function leaveBundle() {
    setBundle(null);
    setSelectedChildId(null);
    setPending(null);
    setError('');
    setPhase('collect');
  }

  const handleDrop = (paths) => processPack(paths?.[0], 'auto');

  function askEditor() {
    return showChoiceDialog({
      title: 'Choisir l’éditeur',
      message: 'Ce pack peut être modifié avec les deux éditeurs.',
      variant: 'info',
      cancelValue: null,
      actions: [
        { value: 'free', label: 'Éditeur par menus', kind: 'secondary' },
        { value: 'advanced', label: 'Éditeur graphe', kind: 'primary', autoFocus: true },
        { value: null, label: 'Annuler', kind: 'ghost' },
      ],
    });
  }
  const editorChooser = editorChooserFor({ openedFromGraph: fromGraph, askEditor });
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
      setError(presentImportError(e, 'simulate'));
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
      {phase === 'busy' && (
        <FunnelGenerationState title={busy.title} hint={busy.hint} progress={progress} />
      )}

      {phase === 'bundle' && bundle && (
        <BundleChildStep
          containerLabel={bundle.containerLabel}
          packs={bundle.children}
          selectedChildId={selectedChildId}
          onSelect={setSelectedChildId}
          onContinue={processBundleChild}
          onBack={leaveBundle}
          error={error}
        />
      )}

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
          <ImportErrorNotice error={error} />
        </div>
      )}

      {phase === 'readOnly' && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<TriangleAlert />}
            title="Pack non éditable"
            description={pending?.advancedError
              ? "Ce pack n'a pu être ouvert ni dans l'Éditeur par menus ni dans l'Éditeur graphe. La simulation reste disponible en lecture seule."
              : "Ce pack n'est pas éditable avec Story Studio. Tu peux quand même le simuler (lecture seule)."}
          />
          <ImportErrorNotice error={pending?.advancedError} context="graph" />
          <ImportErrorNotice error={pending?.report?.reason} context="readOnly" role="status" />
          <ImportErrorNotice error={error} />
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            <FunnelToolButton icon={<Eye />} accent="neutral" onClick={handleSimulate}>
              Simuler le pack
            </FunnelToolButton>
            <FunnelToolButton
              icon={<Undo2 />}
              accent="neutral"
              onClick={backFromVerdict}
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
          <ImportErrorNotice error={pending?.report?.reason} context="unsupported" role="status" />
          <ImportErrorNotice error={pending?.advancedError} context="graph" />
          <ImportErrorNotice error={error} />
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            <FunnelToolButton
              icon={<Undo2 />}
              accent="neutral"
              onClick={backFromVerdict}
            >
              Choisir un autre pack
            </FunnelToolButton>
          </div>
        </div>
      )}
    </FunnelShell>
  );
}
