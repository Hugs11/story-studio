import { createEditorExtractionOwner } from '../../store/catalogue/editorExtractionOwner.js';
import { catalogueOpenApi } from '../../store/catalogue/catalogueOpenApi.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import { translateImport as t } from '../../i18n/importPresentation.js';
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
import { Eye, FolderOpen, Package, SquarePen, TriangleAlert, Undo2, Upload } from '../icons/LucideLocal';
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
  initialSource = null,
  onLand,
  onSimulate,
  onLandAdvanced = null,
  onBeforeReplace = async () => true,
  openedFromGraph = false,
  onNotice = null,
}) {
  useMessageLanguage();
  const { showChoiceDialog } = useErrorDialog();
  // collect | busy | bundle | readOnly | unsupported
  const [phase, setPhase] = useState(initialSource ? 'busy' : 'collect');
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
  const extractionOwnerRef = useRef(null);
  if (!operationLifecycleRef.current) {
    operationLifecycleRef.current = createEditPackOperationLifecycle();
  }

  useEffect(() => {
    operationLifecycleRef.current.activate();
    return () => {
      operationLifecycleRef.current.deactivate();
      extractionOwnerRef.current?.close();
      extractionOwnerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!initialSource) return;
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      if (initialSource.containerPath) void processBundleChild(initialSource, initialSource.childId);
      else void processPack(initialSource.path, initialSource.kind ?? 'auto');
    });
    return () => { disposed = true; };
  // reason: the preselected source belongs to this mounted funnel.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    extractionOwnerRef.current?.close();
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
      if (notice) onNotice?.({ key: 'import:landing.graphOnly.notice' });
      closeFunnel();
    } else if (result.status === 'choice-cancelled') {
      if (initialSource) closeFunnel();
      else setPhase(fallbackPhase);
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
    setBusy({ get title() { return t('import:edit.verification.progress'); }, get hint() { return t('import:edit.wait.hint'); } });
    setPhase('busy');
    const packLabel = initialSource?.packLabel ?? basename(path);
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
          get title() { return t('import:edit.inspection.progress'); },
          get hint() { return t('import:edit.inspection.hint'); },
        });
      },
      beforeLand: (editor) => {
        setBusy({
          get title() { return editor === 'advanced' ? t('import:edit.graphOpening.progress') : t('import:edit.unpacking.progress'); },
          get hint() { return t('import:edit.keepWindow.hint'); },
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
  async function processBundleChild(source = bundle, childId = selectedChildId) {
    // Button events are not sources.
    if (!source?.containerPath) source = bundle;
    if (!source || !childId) return;
    const operation = operationLifecycleRef.current;
    const child = source.children?.find((entry) => entry.childId === childId);
    const packLabel = initialSource?.packLabel ?? child?.displayName ?? source.containerLabel;
    setError('');
    setProgress(null);
    onNotice?.(null);
    setBusy({ get title() { return t('import:edit.childPreparation.progress'); }, get hint() { return t('import:edit.keepWindow.hint'); } });
    setPhase('busy');
    const owner = childId.startsWith('catalogue:')
      ? (extractionOwnerRef.current ??= createEditorExtractionOwner({ ownerId: crypto.randomUUID(), release: id => catalogueOpenApi().releaseEditorExtractions(id) }))
      : null;
    const run = () => runEditPackBundleChildOperation({
      lifecycle: operation,
      containerPath: source.containerPath,
      containerFingerprint: source.containerFingerprint,
      childId,
      extractChild: ({ containerPath, containerFingerprint, childId }) => invoke(
        'extract_pack_bundle_child',
        { path: containerPath, containerFingerprint, childId, ...(owner ? { ownerId: owner.ownerId } : {}) },
      ),
      classify: (zipPath) => invoke('classify_pack_editability', { zipPath }),
      beforeLand: (editor) => {
        setBusy({
          get title() { return editor === 'advanced' ? t('import:edit.graphOpening.progress') : t('import:edit.unpacking.progress'); },
          get hint() { return t('import:edit.keepWindow.hint'); },
        });
      },
      land: (zipPath) => onLand({ zipPath, packLabel }),
      landAdvanced: onLandAdvanced ? (zipPath) => onLandAdvanced({ zipPath, packLabel }) : null,
      chooseEditor: onLandAdvanced ? editorChooser : null,
      beforeReplace: onBeforeReplace,
    });
    const result = owner ? await owner.run(run) : await run();
    if (owner && result.status === 'error') {
      owner.close();
      if (extractionOwnerRef.current === owner) extractionOwnerRef.current = null;
    }
    applyImportResult(result, packLabel, 'bundle');
  }

  // Revenir depuis un verdict ramène à la liste de l'enveloppe quand on en
  // vient, et à la zone de dépôt sinon.
  function backFromVerdict() {
    if (initialSource) { closeFunnel(); return; }
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
      get title() { return t('import:edit.editorChoice.title'); },
      get message() { return t('import:edit.editorChoice.message'); },
      variant: 'info',
      cancelValue: null,
      actions: [
        { value: 'free', get label() { return t('import:edit.menuEditor.action'); }, kind: 'secondary' },
        { value: 'advanced', get label() { return t('import:edit.graphEditor.action'); }, kind: 'primary', autoFocus: true },
        { value: null, get label() { return t('common:dialog.cancel.label'); }, kind: 'ghost' },
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
    setBusy({ get title() { return t('import:edit.simulator.progress'); }, get hint() { return t('import:edit.wait.hint'); } });
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
      icon={<SquarePen />}
      title={t('import:edit.funnel.title')}
      subtitle={initialSource?.packLabel}
      onClose={handleClose}
      closeDisabled={phase === 'busy'}
      showChrome={false}
      fitContent
      ariaLabel={t('import:edit.funnel.title')}
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

      {phase === 'collect' && initialSource && <ImportErrorNotice error={error} />}
      {phase === 'collect' && !initialSource && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<Upload />}
            title={t('import:edit.select.title')}
            description={t('import:edit.select.description')}
          />
          <FunnelDropZone
            title={t('import:edit.drop.title')}
            hint={t('import:edit.drop.hint')}
            onFiles={handleDrop}
          >
            <FunnelToolButton icon={<Package />} accent="neutral" onClick={handleBrowseFile}>{t('import:edit.archive.action')}</FunnelToolButton>
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handleBrowseFolder}>{t('import:edit.folder.action')}</FunnelToolButton>
          </FunnelDropZone>
          <ImportErrorNotice error={error} />
        </div>
      )}

      {phase === 'readOnly' && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<TriangleAlert />}
            title={t('import:edit.readOnly.title')}
            description={pending?.advancedError
              ? t('import:edit.readOnly.bothFailed')
              : t('import:edit.readOnly.description')}
          />
          <ImportErrorNotice error={pending?.advancedError} context="graph" />
          <ImportErrorNotice error={pending?.report?.reasonCode ? { code: pending.report.reasonCode, params: {}, detail: pending.report.reason } : pending?.report?.reason} context="readOnly" role="status" />
          <ImportErrorNotice error={error} />
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            <FunnelToolButton icon={<Eye />} accent="neutral" onClick={handleSimulate}>{t('import:edit.simulate.action')}</FunnelToolButton>
            <FunnelToolButton
              icon={<Undo2 />}
              accent="neutral"
              onClick={backFromVerdict}
            >{t('import:edit.otherPack.action')}</FunnelToolButton>
          </div>
        </div>
      )}

      {phase === 'unsupported' && (
        <div className="funnel-step-content">
          <FunnelSectionHeader
            icon={<TriangleAlert />}
            title={t('import:edit.unsupported.title')}
            description={t('import:edit.unsupported.description')}
          />
          <ImportErrorNotice error={pending?.report?.reasonCode ? { code: pending.report.reasonCode, params: {}, detail: pending.report.reason } : pending?.report?.reason} context="unsupported" role="status" />
          <ImportErrorNotice error={pending?.advancedError} context="graph" />
          <ImportErrorNotice error={error} />
          <div className="funnel-dropzone-actions" style={{ justifyContent: 'flex-start' }}>
            <FunnelToolButton
              icon={<Undo2 />}
              accent="neutral"
              onClick={backFromVerdict}
            >{t('import:edit.otherPack.action')}</FunnelToolButton>
          </div>
        </div>
      )}
    </FunnelShell>
  );
}
