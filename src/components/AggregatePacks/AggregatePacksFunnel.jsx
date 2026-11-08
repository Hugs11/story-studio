import { AggregateDestinationChoice, AggregateGenerationReview } from './AggregateDestinationChoice.jsx';
import { aggregateDestinationReducer, INITIAL_AGGREGATE_DESTINATION, createAggregateConfirmation, moveAggregatePack, refreshAggregateMetadata } from './aggregateLanding.js';
import { nativeGenerationLock } from '../../store/nativeGenerationLock.js';
import { catalogueAssemblyApi } from '../../store/catalogue/catalogueAssemblyApi.js';
import { assemblyPacks } from '../../store/catalogue/assemblySelection.js';
import { AssemblyExcludedList } from '../Catalogue/assembly/AssemblyExcludedList.jsx';
import { translateHome as t } from '../../i18n/homePresentation.js';
import { useHomeTranslation } from '../../i18n/useHomeTranslation.js';
import { useMessageLanguage } from '../../i18n/useMessageLanguage.js';
import {presentUserMessage, presentStoredError } from '../../i18n/userMessage.js';
import { TechnicalDetail } from '../common/UserMessage.jsx';
import { Suspense, lazy, useEffect, useRef, useState, useReducer } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openPath } from '@tauri-apps/plugin-opener';
import { stat } from '@tauri-apps/plugin-fs';
import {
  FunnelDoneState,
  FunnelDropZone,
  FunnelFooter,
  FunnelGenerationState,
  FunnelSectionHeader,
  FunnelShell,
  FunnelStepper,
  FunnelToolButton,
} from '../funnels';
import {
  Crop,
  FolderOpen,
  House,
  Image,
  Mic,
  MoveDown,
  MoveUp,
  Package,
  Pause,
  Play,
  Scissors,
  Sparkles,
  Speech,
  Trash2,
  Upload,
} from '../icons/LucideLocal';
import { convertFolderPackToZip, readPathKinds } from '../../utils/packFolder';
import { pickAudio, pickFolder, pickImage, pickMultipleZip, getLastExportDir, saveLastExportDir } from '../../hooks/useFileDialog';
import { copyMediaToWorkspace, projectToRustExport } from '../../store/projectIO';
import { buildAggregateProject, defaultMetadataForPacks } from './aggregateProject.js';
import { sanitizeImportedName } from '../../store/projectStore';
import { useProjectContext } from '../../store/ProjectContext';
import { isTtsAvailable } from '../../store/xttsSettings';
import { parseConventionName, generateConventionName } from '../../utils/packConvention';
import { generateUuid } from '../../utils/uuid';
import { basename, basenameNoExt } from '../../utils/fileUtils';
import { logger } from '../../utils/logger';
import { useLocalFile } from '../../hooks/useLocalFile';
import { createAudioPlayer, disposeAudioPlayerRef } from '../../utils/audioPlayer';
import './AggregatePacksFunnel.css';

const AudioEditorModal = lazy(() => import('../AudioEditorModal/AudioEditorModal')
  .then((module) => ({ default: module.AudioEditorModal })));
const ImageEditorModal = lazy(() => import('../ImageEditorModal/ImageEditorModal')
  .then((module) => ({ default: module.ImageEditorModal })));
const TextImagePromptModal = lazy(() => import('../TextImageGenerator/TextImagePromptModal')
  .then((module) => ({ default: module.TextImagePromptModal })));
const RecordModal = lazy(() => import('../RecordModal/RecordModal')
  .then((module) => ({ default: module.RecordModal })));
const GenerateVoiceModal = lazy(() => import('../GenerateVoiceModal/GenerateVoiceModal')
  .then((module) => ({ default: module.GenerateVoiceModal })));
const PackNameModal = lazy(() => import('../layout/PackNameModal')
  .then((module) => ({ default: module.PackNameModal })));

const STEPS = [
  { key: 'packs', labelKey: 'home:aggregate.step.packs' },
  { key: 'audio', labelKey: 'home:aggregate.step.audio' },
  { key: 'image', labelKey: 'home:aggregate.step.image' },
  { key: 'metadata', labelKey: 'home:aggregate.step.metadata' },
];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return t('home:aggregate.size.megabytes', { size: mb.toFixed(mb >= 10 ? 0 : 1) });
  return t('home:aggregate.size.kilobytes', { size: Math.max(1, Math.round(bytes / 1024)) });
}

function getSquareOne(data) {
  return (data?.stageNodes || []).find((node) => node?.squareOne === true) ?? null;
}

function getPackStoryCount(data) {
  const stages = Array.isArray(data?.stageNodes) ? data.stageNodes : [];
  return Math.max(0, stages.filter((stage) => !stage?.squareOne).length);
}

export function AggregatePacksFunnel({ onClose, preparation = null, onReleasePreparation, onLand, onLanded }) {
  const { t } = useHomeTranslation();
  useMessageLanguage();
  const { xttsSettings, onUpdateXttsSettings } = useProjectContext();
  const [step, setStep] = useState(0);
  const [packs, setPacks] = useState(() => preparation ? assemblyPacks(preparation) : []);
  const [destination, dispatchDestination] = useReducer(aggregateDestinationReducer, INITIAL_AGGREGATE_DESTINATION);
  const ageEdited = useRef(false);
  const busyRef = useRef(false);
  const cancelledRef = useRef(false);
  const mountedRef = useRef(true);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [rootAudio, setRootAudio] = useState('');
  const [rootImage, setRootImage] = useState('');
  // L'identité du pack est tirée une fois, à l'ouverture de l'assistant : les
  // générations successives livrent le même pack, qui remplace le précédent.
  const [metadata, setMetadata] = useState(() => ({ ...defaultMetadataForPacks([], generateUuid()), minAge: preparation?.suggestedAgeMin == null ? '' : String(preparation.suggestedAgeMin) }));
  const [outputDir, setOutputDir] = useState(() => getLastExportDir() || '');
  const [phase, setPhase] = useState('collect'); // collect | landing | generating | done
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [technicalDetail, setTechnicalDetail] = useState('');
  const [result, setResult] = useState(null);
  const [audioEditorOpen, setAudioEditorOpen] = useState(false);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);
  const [textImageOpen, setTextImageOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const sessionDirRef = useRef('');
  const audioRef = useRef(null);
  const imageUrl = useLocalFile(rootImage);
  const audioUrl = useLocalFile(rootAudio);

  async function cleanupAssistantSession() {
    const sessionDir = sessionDirRef.current;
    if (!sessionDir) return;
    sessionDirRef.current = '';
    await invoke('cleanup_session_workspace', { path: sessionDir }).catch(() => {});
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // A native reader may outlive the surface that launched it.
      if (!busyRef.current) void cleanupAssistantSession();
      disposeAudioPlayerRef(audioRef);
    };
  }, []);

  useEffect(() => {
    disposeAudioPlayerRef(audioRef);
    setAudioPlaying(false);
  }, [audioUrl]);

  useEffect(() => {
    setMetadata(current => refreshAggregateMetadata(current, packs, ageEdited.current));
  }, [packs]);

  async function ensureSessionDir() {
    if (sessionDirRef.current) return sessionDirRef.current;
    const dir = await invoke('create_session_workspace');
    sessionDirRef.current = dir;
    return dir;
  }

  async function copyToSession(path, projectName = metadata.title || 'agregation') {
    if (!path) return path;
    const dir = await ensureSessionDir();
    return copyMediaToWorkspace(path, dir, undefined, projectName);
  }

  async function addPackPaths(paths) {
    // Un dossier de pack vaut une archive : converti par le lecteur unique du moteur,
    // puis traité comme un .zip. Le type réel vient du moteur, pas de l'extension.
    const kinds = await readPathKinds(paths || []);
    const isFolder = (path) => kinds?.get(path) === 'folder';
    const candidates = (paths || [])
      .filter((path) => isFolder(path) || (/\.(zip|7z)$/i.test(path) && kinds?.get(path) !== 'folder'))
      .filter((path) => !packs.some((pack) => (pack.sourcePath ?? pack.path) === path));
    if (candidates.length === 0) return;
    setLoadingPacks(true);
    setError('');
    setTechnicalDetail('');
    try {
      const nextPacks = [];
      for (const sourcePath of candidates) {
        let path = sourcePath;
        try {
          if (isFolder(sourcePath)) path = await convertFolderPackToZip(sourcePath);
          const json = await invoke('load_pack_zip', { zipPath: path });
          const data = JSON.parse(json);
          const sq = getSquareOne(data);
          const fileName = basename(sourcePath) || sourcePath;
          const parsed = parseConventionName(fileName);
          const title = sanitizeImportedName(data.title?.trim() || parsed?.title || basenameNoExt(sourcePath), fileName);
          let sizeBytes = 0;
          try {
            sizeBytes = Number((await stat(path))?.size || 0);
          } catch {}
          nextPacks.push({
            id: crypto.randomUUID(),
            path,
            ...(sourcePath !== path ? { sourcePath } : {}),
            fileName,
            name: title,
            coverImage: sq?.image || null,
            coverAudio: sq?.audio || null,
            packUuid: sq?.uuid || data.uuid || '',
            officialProvenance: data.officialProvenance ?? 'unknown',
            officialOriginUuid: data.officialOriginUuid,
            storyCount: getPackStoryCount(data),
            sizeBytes,
          });
        } catch (packError) {
          const presented = presentUserMessage(packError);
          setError({ userMessage: packError, codedOnly: true, prefix: { key: 'home:aggregate.packs.ignoredPrefix', params: { name: basename(sourcePath) || sourcePath } } });
          setTechnicalDetail(presented.technicalDetail);
        }
      }
      if (nextPacks.length) setPacks((current) => [...current, ...nextPacks]);
    } finally {
      setLoadingPacks(false);
    }
  }

  async function handleBrowsePacks() {
    const files = await pickMultipleZip();
    await addPackPaths(files);
  }

  async function handleBrowsePackFolders() {
    const folders = await pickFolder({ multiple: true });
    await addPackPaths(Array.isArray(folders) ? folders : folders ? [folders] : []);
  }

  async function handlePickAudio() {
    const path = await pickAudio();
    if (path) setRootAudio(path);
  }

  async function handleRecordAudio() {
    await ensureSessionDir();
    setRecordOpen(true);
  }

  async function handleGenerateVoice() {
    await ensureSessionDir();
    setVoiceOpen(true);
  }

  async function handleQueueFunnelVoice(job) {
    const sessionDir = await ensureSessionDir();
    const command = xttsSettings?.backend === 'piper' ? 'piper_generate_audio' : 'xtts_generate_audio';
    const generatedPath = await invoke(command, {
      settings: xttsSettings,
      request: {
        ...job.request,
        savePath: null,
        workspaceDir: sessionDir,
      },
    });
    if (generatedPath) setRootAudio(generatedPath);
  }

  function toggleAudioPreview() {
    if (!audioUrl) return;
    if (audioRef.current && !audioRef.current.paused) {
      audioRef.current.pause();
      setAudioPlaying(false);
      return;
    }

    const audio = audioRef.current ?? createAudioPlayer(audioUrl);
    audioRef.current = audio;
    audio.onended = () => setAudioPlaying(false);
    audio.onpause = () => setAudioPlaying(false);
    audio.play()
      .then(() => setAudioPlaying(true))
      .catch(() => setAudioPlaying(false));
  }

  async function handlePickImage() {
    const path = await pickImage();
    if (path) setRootImage(path);
  }

  function movePack(index, delta) {
    setPacks(current => moveAggregatePack(current, index, delta));
  }

  function removePack(id) {
    setPacks((current) => current.filter((pack) => pack.id !== id));
  }

  function canGoTo(index) {
    if (index <= step) return true;
    if (index >= 1 && packs.length === 0) return false;
    if (index >= 2 && !rootAudio) return false;
    if (index >= 3 && !rootImage) return false;
    return true;
  }

  function handlePrimary() {
    if (step < STEPS.length - 1) {
      if (canGoTo(step + 1)) setStep(step + 1);
      return;
    }
    return;
  }

  function saveMetadataDraft(draft, changedField) {
    if (changedField === 'minAge' || (draft.minAge !== undefined && String(draft.minAge) !== String(metadata.minAge))) ageEdited.current = true;
    setMetadata((current) => ({ ...current, ...draft }));
  }

  async function saveMetadataAndGenerate(draft) {
    if (draft.minAge !== undefined && String(draft.minAge) !== String(metadata.minAge)) ageEdited.current = true;
    const nextMetadata = { ...metadata, ...draft };
    setMetadata(nextMetadata);
    if (destination.destination === 'editor') {
      if (busyRef.current || !onLand) return;
      busyRef.current = true;
      // eslint-disable-next-line i18next/no-literal-string -- État interne de préparation de session.
      setPhase('landing');
      setError('');
      setTechnicalDetail('');
      try {
        const landed = await onLand({ draft: { packs, rootAudio, rootImage, metadata: nextMetadata }, preparation });
        if (landed) {
          await handleClose(true);
          onLanded?.();
          return;
        }
      } catch (landingError) {
        setError({ userMessage: landingError, codedOnly: true });
        setTechnicalDetail(presentUserMessage(landingError).technicalDetail);
      } finally {
        busyRef.current = false;
        if (!mountedRef.current) await cleanupAssistantSession();
        else setPhase('collect');
      }
      return;
    }
    // Le dossier de sortie est choisi ici, au moment de générer (comme le flux
    // normal), plutôt que dans une étape dédiée en amont.
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: t('home:aggregate.output.dialogTitle'),
      defaultPath: outputDir || getLastExportDir() || undefined,
    });
    if (!selected) return;
    setOutputDir(selected);
    saveLastExportDir(selected);
    // eslint-disable-next-line i18next/no-literal-string -- Événement du réducteur de destination.
    dispatchDestination({ type: 'review', confirmation: createAggregateConfirmation({ packs, rootAudio, rootImage, metadata: nextMetadata }, selected) });
  }

  async function generate(confirmation) {
    const { packs, rootAudio, rootImage, metadata: activeMetadata } = confirmation.draft;
    const outputFolder = confirmation.folder;
    if (!packs.length || !rootAudio || !rootImage || !activeMetadata.title?.trim() || !outputFolder) return;
    if (busyRef.current) return;
    const generationLease = nativeGenerationLock.acquire({ owner: 'aggregate', label: activeMetadata.title });
    if (!generationLease) { setError({ key: 'home:aggregate.generation.busy', params: {} }); return; }
    busyRef.current = true;
    cancelledRef.current = false;
    dispatchDestination({ type: 'cancel' });
    setPhase('generating');
    setProgress(0.05);
    setError('');
    setTechnicalDetail('');
    let unlisten = null;
    let timer = null;
    let assemblyTask = null;
    try {
      if (preparation) assemblyTask = await catalogueAssemblyApi.retainTask(preparation.preparationId);
      const sessionDir = await ensureSessionDir();
      const preparedAudio = await copyToSession(rootAudio, activeMetadata.title || 'agregation');
      setProgress(0.12);
      const preparedImage = await copyToSession(rootImage, activeMetadata.title || 'agregation');
      setProgress(0.18);
      const preparedPacks = [];
      for (let index = 0; index < packs.length; index += 1) {
        const pack = packs[index];
        const copiedZip = await copyToSession(pack.path, activeMetadata.title || 'agregation');
        preparedPacks.push({ ...pack, path: copiedZip, coverImage: pack.coverImage ? await copyToSession(pack.coverImage, activeMetadata.title) : pack.coverImage, coverAudio: pack.coverAudio ? await copyToSession(pack.coverAudio, activeMetadata.title) : pack.coverAudio });
        setProgress(0.18 + ((index + 1) / packs.length) * 0.18);
      }

      const project = buildAggregateProject({
        packs: preparedPacks,
        rootAudio: preparedAudio,
        rootImage: preparedImage,
        metadata: activeMetadata,
      });
      const projectJson = JSON.stringify(projectToRustExport(project));
      unlisten = await listen('generate-log', () => {
        setProgress((current) => Math.min(0.94, current + 0.035));
      });
      timer = window.setInterval(() => {
        setProgress((current) => Math.min(0.9, current + 0.012));
      }, 350);
      logger.info(`aggregate-funnel:generate start count=${packs.length} output='${outputFolder}' session='${sessionDir}'`);
      if (cancelledRef.current) throw { key: 'home:aggregate.generation.cancelled', params: {} };
      const generationResult = await invoke('generate_pack', { projectJson, outputFolder });
      const resultPath = typeof generationResult === 'string'
        ? generationResult
        : generationResult?.zipPath;
      const warnings = Array.isArray(generationResult?.warnings)
        ? generationResult.warnings
        : [];
      if (!resultPath) throw { key: 'home:aggregate.generation.missingPath', params: {} };
      window.clearInterval(timer);
      timer = null;
      unlisten?.();
      unlisten = null;
      setProgress(1);
      let sizeBytes = 0;
      try {
        sizeBytes = Number((await stat(resultPath))?.size || 0);
      } catch {}
      setResult({
        path: resultPath,
        fileName: basename(resultPath) || `${generateConventionName(activeMetadata)}.zip`,
        sizeBytes,
        packCount: packs.length,
        storyCount: packs.reduce((sum, pack) => sum + (pack.storyCount || 0), 0),
        warnings,
      });
      setPhase('done');
    } catch (generationError) {
      window.clearInterval(timer);
      unlisten?.();
      const presented = presentUserMessage(generationError);
      setError({ userMessage: generationError, codedOnly: true, prefix: { key: 'home:aggregate.generation.errorPrefix' } });
      setTechnicalDetail(presented.technicalDetail);
      setPhase('collect');
    } finally {
      try { if (assemblyTask) await catalogueAssemblyApi.finishTask(assemblyTask.leaseId); }
      finally {
        generationLease.release();
        busyRef.current = false;
        if (!mountedRef.current) await cleanupAssistantSession();
      }
    }
  }

  async function handleClose(landed = false) {
    if (busyRef.current && landed !== true) return;
    await cleanupAssistantSession();
    await onReleasePreparation?.();
    onClose?.();
  }

  const totalStories = packs.reduce((sum, pack) => sum + (pack.storyCount || 0), 0);
  const totalSize = packs.reduce((sum, pack) => sum + (pack.sizeBytes || 0), 0);
  const ttsAvailable = isTtsAvailable(xttsSettings);
  const primaryDisabled = (
    (step === 0 && (packs.length === 0 || loadingPacks))
    || (step === 1 && !rootAudio)
    || (step === 2 && !rootImage)
  );
  const previewProject = buildAggregateProject({ packs, rootAudio, rootImage, metadata });
  const generationPhases = [
    { label: t('home:aggregate.phase.combine'), status: progress >= 0.28 ? 'done' : 'active' },
    { label: t('home:aggregate.phase.volume'), status: progress < 0.28 ? 'todo' : progress >= 0.55 ? 'done' : 'active' },
    { label: t('home:aggregate.phase.images'), status: progress < 0.55 ? 'todo' : progress >= 0.8 ? 'done' : 'active' },
    { label: t('home:aggregate.phase.archive'), status: progress < 0.8 ? 'todo' : progress >= 1 ? 'done' : 'active' },
  ];

  return (
    <FunnelShell
      icon={<Package />}
      title={t('home:modeSelector.aggregate.label')}
      subtitle={t('home:aggregate.header.description')}
      onClose={() => handleClose()}
      closeDisabled={phase === 'generating' || phase === 'landing'}
      showChrome={phase === 'collect'}
      size="wide"
      ariaLabel={t('home:modeSelector.aggregate.label')}
      stepper={(
        <FunnelStepper
          steps={STEPS.map((step) => ({ ...step, label: t(step.labelKey) }))}
          current={step}
          onStepClick={(index) => { if (canGoTo(index)) setStep(index); }}
          disabled={phase !== 'collect'}
        />
      )}
      footer={phase === 'collect' && step === STEPS.length - 1 ? null : (
        <FunnelFooter
          onBack={() => setStep((current) => Math.max(0, current - 1))}
          backDisabled={step === 0}
          stepLabel={t('home:funnel.footer.stepCount', { step: step + 1, total: STEPS.length })}
          onPrimary={handlePrimary}
          primaryLabel={step === STEPS.length - 1 ? t('home:aggregate.generation.action') : t('home:funnel.footer.continue')}
          primaryIcon={step === STEPS.length - 1 ? <Package /> : null}
          primaryDisabled={primaryDisabled}
        />
      )}
    >
      {phase === 'landing' && <p role="status">{t('home:aggregate.destination.opening')}</p>}
      {phase === 'generating' && (
        <div><button type="button" className="funnel-btn" onClick={() => { cancelledRef.current = true; void invoke('cancel_generate_pack').catch(() => {}); }}>{t('common:dialog.cancel.label')}</button>
        <FunnelGenerationState
          title={t('home:aggregate.generation.title')}
          hint={t('home:funnel.generation.hint')}
          phases={generationPhases}
          progress={progress}
        /></div>
      )}

      {phase === 'done' && (
        <FunnelDoneState
          title={t('home:aggregate.done.title')}
          fileName={result?.fileName}
          meta={[
            formatBytes(result?.sizeBytes),
            t('home:aggregate.count.stories', { count: result?.storyCount ?? totalStories }),
            t('home:aggregate.done.packCount', { count: result?.packCount ?? packs.length }),
          ].filter(Boolean).join(' · ')}
          notice={result?.warnings?.length ? (
            <div>
              <strong>
                {t('home:aggregate.done.audioWarnings', { count: result.warnings.length })}
              </strong>
              {result.warnings.map((warning, index) => (
                <div key={`${warning.code || 'audio'}-${warning.role || index}`}>{presentUserMessage(warning).message}<TechnicalDetail value={presentUserMessage(warning).technicalDetail} /></div>
              ))}
              <small>{t('home:aggregate.done.warningHint')}</small>
            </div>
          ) : null}
        >
          <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={() => outputDir && openPath(outputDir)}>{t('home:aggregate.done.openFolder')}</FunnelToolButton>
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={() => handleClose()}>
            <span>{t('home:aggregate.done.finish')}</span>
            <House />
          </button>
        </FunnelDoneState>
      )}

      {phase === 'collect' && step === 0 && (
        <div className="funnel-step-content aggregate-step">
          <AssemblyExcludedList entries={preparation?.excluded} />
          <FunnelSectionHeader
            icon={<Package />}
            title={t('home:aggregate.packs.title')}
            description={t('home:aggregate.packs.description')}
          />
          <FunnelDropZone
            icon={<Upload />}
            title={t('home:aggregate.packs.dropTitle')}
            hint={t('home:aggregate.packs.formats')}
            onFiles={addPackPaths}
            disabled={loadingPacks}
          >
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handleBrowsePacks} disabled={loadingPacks}>{t('home:aggregate.packs.browse')}</FunnelToolButton>
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handleBrowsePackFolders} disabled={loadingPacks}>{t('home:aggregate.packs.browseFolder')}</FunnelToolButton>
          </FunnelDropZone>

          {preparation && <p>{t('catalogue:assembly.effectiveValues')}</p>}
          {packs.length > 0 && (
            <div className="aggregate-pack-list">
              {packs.map((pack, index) => (
                <div className="aggregate-pack-row" key={pack.id}>
                  <span className="aggregate-pack-handle" aria-hidden="true">⋮⋮</span>
                  <span className="aggregate-pack-icon"><Package /></span>
                  <span className="aggregate-pack-copy">
                    {preparation && pack.provenance?.some(field => field.effective?.origin === 'correction' || field.effective?.origin === 'cleared') && <span>{t('catalogue:data.corrected')}</span>}
                    {preparation ? <input aria-label={t('home:aggregate.packs.title')} value={pack.name} onChange={event => setPacks(current => current.map(item => item.id === pack.id ? { ...item, name: event.target.value } : item))} /> : <span className="aggregate-pack-name" title={pack.fileName}>{pack.fileName}</span>}
                    <span className="aggregate-pack-meta">
                      {preparation && <button type="button" onClick={async () => { const image = await pickImage(); if (image) setPacks(current => current.map(item => item.id === pack.id ? { ...item, coverImage: image } : item)); }}>{t('home:aggregate.image.choose')}</button>}
                      {[formatBytes(pack.sizeBytes), t('home:aggregate.count.scenes', { count: pack.storyCount })].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <button type="button" className="aggregate-icon-btn" onClick={() => movePack(index, -1)} disabled={index === 0} aria-label={t('home:aggregate.packs.moveUp')}>
                    <MoveUp />
                  </button>
                  <button type="button" className="aggregate-icon-btn" onClick={() => movePack(index, 1)} disabled={index === packs.length - 1} aria-label={t('home:aggregate.packs.moveDown')}>
                    <MoveDown />
                  </button>
                  <button type="button" className="aggregate-icon-btn" onClick={() => removePack(pack.id)} aria-label={t('home:aggregate.packs.remove')}>
                    <Trash2 />
                  </button>
                </div>
              ))}
              <div className="aggregate-pack-list-foot">
                <span>{t('home:aggregate.count.packs', { count: packs.length })} · {t('home:aggregate.count.scenes', { count: totalStories })}</span>
                <span>{formatBytes(totalSize)}</span>
              </div>
            </div>
          )}
          {loadingPacks && <div className="aggregate-inline-note">{t('home:aggregate.packs.loading')}</div>}
          {error && <div className="funnel-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={technicalDetail} /></div>}
        </div>
      )}

      {phase === 'collect' && step === 1 && (
        <div className="funnel-step-content aggregate-step">
          <FunnelSectionHeader
            icon={<Mic />}
            title={t('home:aggregate.audio.title')}
            description={t('home:aggregate.audio.description')}
          />
          <div className="aggregate-audio-card">
            <button
              type="button"
              className="aggregate-play-btn"
              disabled={!audioUrl}
              aria-label={audioPlaying ? t('home:aggregate.audio.pause') : t('home:aggregate.audio.play')}
              onClick={toggleAudioPreview}
            >
              {audioPlaying ? <Pause /> : <Play />}
            </button>
            <div className="aggregate-wave" aria-hidden="true">
              {Array.from({ length: 42 }).map((_, index) => (
                <span key={index} style={{ height: `${10 + ((index * 13) % 30)}px` }} />
              ))}
            </div>
            <div className="aggregate-selected-file" title={rootAudio}>{rootAudio ? basename(rootAudio) : t('home:aggregate.audio.empty')}</div>
          </div>
          <div className="aggregate-tool-grid">
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" block onClick={handlePickAudio}>{t('home:aggregate.audio.choose')}</FunnelToolButton>
            <FunnelToolButton icon={<Mic />} accent="violet" variant="solid" block onClick={handleRecordAudio}>{t('home:aggregate.audio.record')}</FunnelToolButton>
            {ttsAvailable && (
              <FunnelToolButton icon={<Speech />} accent="violet" variant="solid" block onClick={handleGenerateVoice}>{t('home:aggregate.audio.voice')}</FunnelToolButton>
            )}
            <FunnelToolButton icon={<Scissors />} accent="neutral" block onClick={async () => {
              if (!rootAudio) return;
              await ensureSessionDir();
              setAudioEditorOpen(true);
            }} disabled={!rootAudio}>{t('home:aggregate.audio.edit')}</FunnelToolButton>
          </div>
        </div>
      )}

      {phase === 'collect' && step === 2 && (
        <div className="funnel-step-content aggregate-step">
          <FunnelSectionHeader
            icon={<Image />}
            title={t('home:aggregate.image.title')}
            description={t('home:aggregate.image.description')}
          />
          <div className="aggregate-image-layout">
            <div className="aggregate-image-preview">
              {imageUrl ? <img src={imageUrl} alt="" /> : (
                <div className="aggregate-image-placeholder">
                  <strong>{metadata.title || t('home:aggregate.creation.title')}</strong>
                  <span>{t('home:aggregate.count.combined', { count: packs.length })}</span>
                </div>
              )}
            </div>
            <div className="aggregate-image-actions">
              <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handlePickImage}>{t('home:aggregate.image.choose')}</FunnelToolButton>
              <FunnelToolButton
                icon={<Sparkles />}
                accent="violet"
                variant="solid"
                onClick={async () => {
                  try {
                    await ensureSessionDir();
                    setTextImageOpen(true);
                  } catch (sessionError) {
                    setError({ userMessage: sessionError, codedOnly: true, prefix: { key: 'home:aggregate.session.errorPrefix' } });
                    setTechnicalDetail(presentUserMessage(sessionError).technicalDetail);
                  }
                }}
              >{t('home:aggregate.image.generate')}</FunnelToolButton>
              <FunnelToolButton icon={<Crop />} accent="violet" variant="outline" onClick={async () => {
                await ensureSessionDir();
                setImageEditorOpen(true);
              }} disabled={!rootImage}>{t('home:aggregate.image.edit')}</FunnelToolButton>
              <div className="aggregate-inline-note">{t('home:aggregate.image.dimensionsHint')}</div>
            </div>
          </div>
        </div>
      )}

      {phase === 'collect' && step === 3 && (
        <div className="funnel-step-content aggregate-step aggregate-metadata-step">
          <FunnelSectionHeader
            icon={<Package />}
            title={t('home:aggregate.step.metadata')}
            description={t('home:aggregate.metadata.description')}
            trailing={<span className="funnel-badge">{t('home:aggregate.metadata.badge')}</span>}
          />
          {/* eslint-disable-next-line i18next/no-literal-string -- Événement interne du choix de destination. */}
          <AggregateDestinationChoice destination={destination.destination} onChoose={value => dispatchDestination({ type: 'choose', destination: value })} />
          {destination.confirmation ? <AggregateGenerationReview {...destination.confirmation}
            onCancel={() => dispatchDestination({ type: 'cancel' })}
            onConfirm={() => { const review = destination.confirmation; void generate(review); }} /> : <Suspense fallback={null}>
            <PackNameModal
              open
              embedded
              packMetadata={metadata}
              project={previewProject}
              coverImage={rootImage}
              exportFolder={outputDir || null}
              onDraftChange={saveMetadataDraft}
              onSave={saveMetadataDraft}
              onSaveAndGenerate={saveMetadataAndGenerate}
              primaryActionLabel={destination.destination === 'editor' ? t('home:aggregate.destination.editor') : t('home:aggregate.destination.review')}
              onClose={() => setStep(2)}
            />
          </Suspense>}
          {error && <div className="funnel-error" role="alert">{presentStoredError(error)}<TechnicalDetail value={technicalDetail} /></div>}
        </div>
      )}

      {audioEditorOpen && rootAudio && (
        <Suspense fallback={null}>
          <AudioEditorModal
            filePath={rootAudio}
            savePath={null}
            workspaceDir={sessionDirRef.current || null}
            onConfirm={(result) => {
              const outputPath = typeof result === 'string' ? result : result?.output_path;
              if (outputPath) setRootAudio(outputPath);
              setAudioEditorOpen(false);
            }}
            onCancel={() => setAudioEditorOpen(false)}
          />
        </Suspense>
      )}

      {recordOpen && (
        <Suspense fallback={null}>
          <RecordModal
            workspaceDir={sessionDirRef.current || null}
            projectName={metadata.title || 'agregation'}
            onSaved={(path) => {
              if (path) setRootAudio(path);
              setRecordOpen(false);
            }}
            onClose={() => setRecordOpen(false)}
          />
        </Suspense>
      )}

      {voiceOpen && ttsAvailable && (
        <Suspense fallback={null}>
          <GenerateVoiceModal
            savePath={null}
            xttsSettings={xttsSettings}
            label={t('home:aggregate.audio.title')}
            labelRef={{ key: 'home:aggregate.audio.title' }}
            initialText={metadata.title || t('home:aggregate.creation.title')}
            filenameHint={`menu-${metadata.title || 'agregation'}`}
            target={null}
            onUpdateXttsSettings={onUpdateXttsSettings}
            onQueueGenerate={handleQueueFunnelVoice}
            onClose={() => setVoiceOpen(false)}
          />
        </Suspense>
      )}

      {imageEditorOpen && rootImage && (
        <Suspense fallback={null}>
          <ImageEditorModal
            sourcePath={rootImage}
            workspaceDir={sessionDirRef.current || ''}
            forceExport
            onConfirm={(path) => {
              if (path) setRootImage(path);
              setImageEditorOpen(false);
            }}
            onCancel={() => setImageEditorOpen(false)}
          />
        </Suspense>
      )}

      {textImageOpen && (
        <Suspense fallback={null}>
          <TextImagePromptModal
            defaultText={metadata.title || t('home:aggregate.creation.title')}
            workspaceDir={sessionDirRef.current || ''}
            onConfirm={(path) => {
              if (path) setRootImage(path);
              setTextImageOpen(false);
            }}
            onCancel={() => setTextImageOpen(false)}
          />
        </Suspense>
      )}
    </FunnelShell>
  );
}
