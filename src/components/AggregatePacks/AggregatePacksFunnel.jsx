import { Suspense, lazy, useEffect, useRef, useState } from 'react';
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
  Check,
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
import { pickAudio, pickImage, pickMultipleZip, getLastExportDir, saveLastExportDir } from '../../hooks/useFileDialog';
import { copyMediaToWorkspace, projectToRustExport } from '../../store/projectIO';
import { createZipEntry, DEFAULT_PACK_METADATA, normalizeProjectData } from '../../store/projectModel';
import { sanitizeImportedName } from '../../store/projectStore';
import { useProjectContext } from '../../store/ProjectContext';
import { isTtsAvailable } from '../../store/xttsSettings';
import { parseConventionName, generateConventionName } from '../../utils/packConvention';
import { basename, basenameNoExt } from '../../utils/fileUtils';
import { logger } from '../../utils/logger';
import { useLocalFile } from '../../hooks/useLocalFile';
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
  { key: 'packs', label: 'Packs' },
  { key: 'audio', label: 'Audio' },
  { key: 'image', label: 'Image' },
  { key: 'output', label: 'Sortie' },
  { key: 'metadata', label: 'Métadonnées' },
];

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function joinPath(dir, fileName) {
  if (!dir) return fileName || '';
  return `${String(dir).replace(/[\\/]+$/, '')}\\${fileName}`;
}

function getSquareOne(data) {
  return (data?.stageNodes || []).find((node) => node?.squareOne === true) ?? null;
}

function getPackStoryCount(data) {
  const stages = Array.isArray(data?.stageNodes) ? data.stageNodes : [];
  return Math.max(0, stages.filter((stage) => !stage?.squareOne).length);
}

function defaultMetadataForPacks(packs) {
  const parsed = packs
    .map((pack) => parseConventionName(pack.name || pack.fileName))
    .filter(Boolean);
  const ages = parsed
    .map((item) => Number.parseInt(item.minAge, 10))
    .filter((age) => Number.isFinite(age) && age > 0);
  return {
    ...DEFAULT_PACK_METADATA,
    title: 'Mes histoires du soir',
    minAge: ages.length ? String(Math.min(...ages)) : '3',
    version: 1,
  };
}

function buildAggregateProject({ packs, rootAudio, rootImage, metadata, harmonizeLoudness }) {
  return normalizeProjectData({
    version: 1,
    projectName: metadata.title || 'Pack agrégé',
    rootName: metadata.title || 'Menu racine',
    packMetadata: metadata,
    projectType: 'pack',
    rootAudio,
    rootImage,
    thumbnailImage: rootImage,
    sameImage: true,
    globalOptions: {
      silenceMode: 'normalize',
      harmonizeLoudness,
      autoNext: false,
      nightMode: false,
      aiImageGen: false,
    },
    rootEntries: packs.map((pack) => createZipEntry({
      name: pack.name,
      zipPath: pack.path,
      coverImage: pack.coverImage,
      coverAudio: pack.coverAudio,
    })),
  });
}

export function AggregatePacksFunnel({ onClose }) {
  const { xttsSettings, onUpdateXttsSettings } = useProjectContext();
  const [step, setStep] = useState(0);
  const [packs, setPacks] = useState([]);
  const [loadingPacks, setLoadingPacks] = useState(false);
  const [rootAudio, setRootAudio] = useState('');
  const [rootImage, setRootImage] = useState('');
  const [metadata, setMetadata] = useState(() => defaultMetadataForPacks([]));
  const [harmonizeLoudness, setHarmonizeLoudness] = useState(true);
  const [outputDir, setOutputDir] = useState(() => getLastExportDir() || '');
  const [phase, setPhase] = useState('collect'); // collect | generating | done
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
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

  useEffect(() => {
    return () => {
      const sessionDir = sessionDirRef.current;
      if (sessionDir) invoke('cleanup_session_workspace', { path: sessionDir }).catch(() => {});
      audioRef.current?.pause();
    };
  }, []);

  useEffect(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setAudioPlaying(false);
  }, [audioUrl]);

  useEffect(() => {
    if (packs.length === 0) return;
    setMetadata((current) => {
      if (current.title && current.title !== 'Mes histoires du soir') return current;
      return { ...current, ...defaultMetadataForPacks(packs) };
    });
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
    const candidates = (paths || [])
      .filter((path) => /\.(zip|7z)$/i.test(path))
      .filter((path) => !packs.some((pack) => pack.path === path));
    if (candidates.length === 0) return;
    setLoadingPacks(true);
    setError('');
    try {
      const nextPacks = [];
      for (const path of candidates) {
        try {
          const json = await invoke('load_pack_zip', { zipPath: path });
          const data = JSON.parse(json);
          const sq = getSquareOne(data);
          const fileName = basename(path) || path;
          const parsed = parseConventionName(fileName);
          const title = sanitizeImportedName(data.title?.trim() || parsed?.title || basenameNoExt(path), fileName);
          let sizeBytes = 0;
          try {
            sizeBytes = Number((await stat(path))?.size || 0);
          } catch {}
          nextPacks.push({
            id: crypto.randomUUID(),
            path,
            fileName,
            name: title,
            coverImage: sq?.image || null,
            coverAudio: sq?.audio || null,
            storyCount: getPackStoryCount(data),
            sizeBytes,
          });
        } catch (packError) {
          setError(`Pack ignoré : ${basename(path) || path}\n${packError}`);
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

    const audio = audioRef.current ?? new Audio(audioUrl);
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

  async function handlePickOutputDir() {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      title: 'Dossier de sortie du pack',
      defaultPath: outputDir || getLastExportDir() || undefined,
    });
    if (selected) {
      setOutputDir(selected);
      saveLastExportDir(selected);
    }
  }

  function movePack(index, delta) {
    setPacks((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function removePack(id) {
    setPacks((current) => current.filter((pack) => pack.id !== id));
  }

  function canGoTo(index) {
    if (index <= step) return true;
    if (index >= 1 && packs.length === 0) return false;
    if (index >= 2 && !rootAudio) return false;
    if (index >= 3 && !rootImage) return false;
    if (index >= 4 && !outputDir) return false;
    return true;
  }

  function handlePrimary() {
    if (step < STEPS.length - 1) {
      if (canGoTo(step + 1)) setStep(step + 1);
      return;
    }
    void generate();
  }

  function saveMetadataDraft(draft) {
    setMetadata((current) => ({ ...current, ...draft }));
  }

  async function saveMetadataAndGenerate(draft) {
    const nextMetadata = { ...metadata, ...draft };
    setMetadata(nextMetadata);
    await generate(nextMetadata);
  }

  async function generate(metadataOverride = metadata) {
    const activeMetadata = { ...metadata, ...metadataOverride };
    if (!packs.length || !rootAudio || !rootImage || !activeMetadata.title?.trim() || !outputDir) return;
    setPhase('generating');
    setProgress(0.05);
    setError('');
    let unlisten = null;
    let timer = null;
    try {
      const sessionDir = await ensureSessionDir();
      const preparedAudio = await copyToSession(rootAudio, activeMetadata.title || 'agregation');
      setProgress(0.12);
      const preparedImage = await copyToSession(rootImage, activeMetadata.title || 'agregation');
      setProgress(0.18);
      const preparedPacks = [];
      for (let index = 0; index < packs.length; index += 1) {
        const pack = packs[index];
        const copiedZip = await copyToSession(pack.path, activeMetadata.title || 'agregation');
        preparedPacks.push({ ...pack, path: copiedZip });
        setProgress(0.18 + ((index + 1) / packs.length) * 0.18);
      }

      const project = buildAggregateProject({
        packs: preparedPacks,
        rootAudio: preparedAudio,
        rootImage: preparedImage,
        metadata: activeMetadata,
        harmonizeLoudness,
      });
      const projectJson = JSON.stringify(projectToRustExport(project));
      unlisten = await listen('generate-log', () => {
        setProgress((current) => Math.min(0.94, current + 0.035));
      });
      timer = window.setInterval(() => {
        setProgress((current) => Math.min(0.9, current + 0.012));
      }, 350);
      logger.info(`aggregate-funnel:generate start count=${packs.length} output='${outputDir}' session='${sessionDir}'`);
      const resultPath = await invoke('generate_pack', { projectJson, outputFolder: outputDir });
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
      });
      if (sessionDirRef.current) {
        await invoke('cleanup_session_workspace', { path: sessionDirRef.current }).catch(() => {});
        sessionDirRef.current = '';
      }
      setPhase('done');
    } catch (generationError) {
      window.clearInterval(timer);
      unlisten?.();
      setError(`La génération a échoué : ${generationError?.message ?? generationError}`);
      setPhase('collect');
      if (sessionDirRef.current) {
        await invoke('cleanup_session_workspace', { path: sessionDirRef.current }).catch(() => {});
        sessionDirRef.current = '';
      }
    }
  }

  async function handleClose() {
    if (phase === 'generating') return;
    const sessionDir = sessionDirRef.current;
    if (sessionDir) {
      await invoke('cleanup_session_workspace', { path: sessionDir }).catch(() => {});
      sessionDirRef.current = '';
    }
    onClose?.();
  }

  const totalStories = packs.reduce((sum, pack) => sum + (pack.storyCount || 0), 0);
  const totalSize = packs.reduce((sum, pack) => sum + (pack.sizeBytes || 0), 0);
  const exportName = generateConventionName(metadata);
  const outputFileName = exportName ? `${exportName}.zip` : 'Titre requis';
  const ttsAvailable = isTtsAvailable(xttsSettings);
  const primaryDisabled = (
    (step === 0 && (packs.length === 0 || loadingPacks))
    || (step === 1 && !rootAudio)
    || (step === 2 && !rootImage)
    || (step === 3 && !outputDir)
    || (step === 4 && !metadata.title?.trim())
  );
  const previewProject = buildAggregateProject({ packs, rootAudio, rootImage, metadata, harmonizeLoudness });
  const generationPhases = [
    { label: 'Agrégation des packs', status: progress >= 0.28 ? 'done' : 'active' },
    { label: 'Harmonisation du volume', status: progress < 0.28 ? 'todo' : progress >= 0.55 ? 'done' : 'active' },
    { label: 'Encodage des images 320x240', status: progress < 0.55 ? 'todo' : progress >= 0.8 ? 'done' : 'active' },
    { label: 'Construction du ZIP', status: progress < 0.8 ? 'todo' : progress >= 1 ? 'done' : 'active' },
  ];

  return (
    <FunnelShell
      icon={<Package />}
      title="Agréger des packs"
      subtitle="Génère un nouveau pack à partir de plusieurs archives."
      onClose={handleClose}
      showChrome={phase === 'collect'}
      ariaLabel="Agréger des packs"
      stepper={(
        <FunnelStepper
          steps={STEPS}
          current={step}
          onStepClick={(index) => { if (canGoTo(index)) setStep(index); }}
          disabled={phase !== 'collect'}
        />
      )}
      footer={phase === 'collect' && step === STEPS.length - 1 ? null : (
        <FunnelFooter
          onBack={() => setStep((current) => Math.max(0, current - 1))}
          backDisabled={step === 0}
          stepLabel={`Étape ${step + 1} / ${STEPS.length}`}
          onPrimary={handlePrimary}
          primaryLabel={step === STEPS.length - 1 ? 'Générer le pack' : 'Continuer'}
          primaryIcon={step === STEPS.length - 1 ? <Package /> : null}
          primaryDisabled={primaryDisabled}
        />
      )}
    >
      {phase === 'generating' && (
        <FunnelGenerationState
          title="Génération du pack…"
          hint="Ne ferme pas la fenêtre."
          phases={generationPhases}
          progress={progress}
        />
      )}

      {phase === 'done' && (
        <FunnelDoneState
          title="Pack généré"
          fileName={result?.fileName}
          meta={[
            formatBytes(result?.sizeBytes),
            `${result?.storyCount ?? totalStories} histoire${(result?.storyCount ?? totalStories) > 1 ? 's' : ''}`,
            `${result?.packCount ?? packs.length} packs agrégés`,
          ].filter(Boolean).join(' · ')}
        >
          <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={() => outputDir && openPath(outputDir)}>
            Ouvrir le dossier
          </FunnelToolButton>
          <button type="button" className="funnel-btn funnel-btn-primary" onClick={handleClose}>
            <span>Terminer</span>
            <House />
          </button>
        </FunnelDoneState>
      )}

      {phase === 'collect' && step === 0 && (
        <div className="funnel-step-content aggregate-step">
          <FunnelSectionHeader
            icon={<Package />}
            title="Sélection des packs"
            description="Glisse plusieurs .zip ou .7z — l'ordre définit le menu agrégé."
          />
          <FunnelDropZone
            icon={<Upload />}
            title="Dépose tes archives ici"
            hint="Formats acceptés : .zip, .7z · plusieurs à la fois"
            onFiles={addPackPaths}
            disabled={loadingPacks}
          >
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handleBrowsePacks} disabled={loadingPacks}>
              Parcourir…
            </FunnelToolButton>
          </FunnelDropZone>

          {packs.length > 0 && (
            <div className="aggregate-pack-list">
              {packs.map((pack, index) => (
                <div className="aggregate-pack-row" key={pack.id}>
                  <span className="aggregate-pack-handle" aria-hidden="true">⋮⋮</span>
                  <span className="aggregate-pack-icon"><Package /></span>
                  <span className="aggregate-pack-copy">
                    <span className="aggregate-pack-name" title={pack.fileName}>{pack.fileName}</span>
                    <span className="aggregate-pack-meta">
                      {[formatBytes(pack.sizeBytes), `${pack.storyCount} scène${pack.storyCount > 1 ? 's' : ''}`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <button type="button" className="aggregate-icon-btn" onClick={() => movePack(index, -1)} disabled={index === 0} aria-label="Monter">
                    <MoveUp />
                  </button>
                  <button type="button" className="aggregate-icon-btn" onClick={() => movePack(index, 1)} disabled={index === packs.length - 1} aria-label="Descendre">
                    <MoveDown />
                  </button>
                  <button type="button" className="aggregate-icon-btn" onClick={() => removePack(pack.id)} aria-label="Retirer">
                    <Trash2 />
                  </button>
                </div>
              ))}
              <div className="aggregate-pack-list-foot">
                <span>{packs.length} pack{packs.length > 1 ? 's' : ''} · {totalStories} scène{totalStories > 1 ? 's' : ''}</span>
                <span>{formatBytes(totalSize)}</span>
              </div>
            </div>
          )}
          {loadingPacks && <div className="aggregate-inline-note">Lecture des métadonnées…</div>}
          {error && <div className="funnel-error" role="alert">{error}</div>}
        </div>
      )}

      {phase === 'collect' && step === 1 && (
        <div className="funnel-step-content aggregate-step">
          <FunnelSectionHeader
            icon={<Mic />}
            title="Audio du menu"
            description="La voix qui annonce le menu agrégé sur la Boîte à Histoires."
          />
          <div className="aggregate-audio-card">
            <button
              type="button"
              className="aggregate-play-btn"
              disabled={!audioUrl}
              aria-label={audioPlaying ? "Mettre l'audio en pause" : "Lire l'audio"}
              onClick={toggleAudioPreview}
            >
              {audioPlaying ? <Pause /> : <Play />}
            </button>
            <div className="aggregate-wave" aria-hidden="true">
              {Array.from({ length: 42 }).map((_, index) => (
                <span key={index} style={{ height: `${10 + ((index * 13) % 30)}px` }} />
              ))}
            </div>
            <div className="aggregate-selected-file" title={rootAudio}>{rootAudio ? basename(rootAudio) : 'Aucun audio choisi'}</div>
          </div>
          <div className="aggregate-tool-grid">
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" block onClick={handlePickAudio}>
              Choisir un audio
            </FunnelToolButton>
            <FunnelToolButton icon={<Mic />} accent="violet" variant="solid" block onClick={handleRecordAudio}>
              Enregistrer au micro
            </FunnelToolButton>
            {ttsAvailable && (
              <FunnelToolButton icon={<Speech />} accent="violet" variant="solid" block onClick={handleGenerateVoice}>
                Générer une voix
              </FunnelToolButton>
            )}
            <FunnelToolButton icon={<Scissors />} accent="neutral" block onClick={async () => {
              if (!rootAudio) return;
              await ensureSessionDir();
              setAudioEditorOpen(true);
            }} disabled={!rootAudio}>
              Édition audio
            </FunnelToolButton>
          </div>
        </div>
      )}

      {phase === 'collect' && step === 2 && (
        <div className="funnel-step-content aggregate-step">
          <FunnelSectionHeader
            icon={<Image />}
            title="Image de couverture"
            description="Image affichée à l'écran de la Boîte à Histoires."
          />
          <div className="aggregate-image-layout">
            <div className="aggregate-image-preview">
              {imageUrl ? <img src={imageUrl} alt="" /> : (
                <div className="aggregate-image-placeholder">
                  <strong>{metadata.title || 'Mes histoires du soir'}</strong>
                  <span>{packs.length} pack{packs.length > 1 ? 's' : ''} agrégé{packs.length > 1 ? 's' : ''}</span>
                </div>
              )}
            </div>
            <div className="aggregate-image-actions">
              <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handlePickImage}>
                Choisir une image
              </FunnelToolButton>
              <FunnelToolButton icon={<Sparkles />} accent="violet" variant="solid" onClick={() => setTextImageOpen(true)}>
                Générer un texte
              </FunnelToolButton>
              <FunnelToolButton icon={<Crop />} accent="violet" variant="outline" onClick={() => setImageEditorOpen(true)} disabled={!rootImage}>
                Retouche image
              </FunnelToolButton>
              <div className="aggregate-inline-note">320 × 240 · recadrage automatique à la génération.</div>
            </div>
          </div>
        </div>
      )}

      {phase === 'collect' && step === 3 && (
        <div className="funnel-step-content aggregate-step">
          <FunnelSectionHeader
            icon={<FolderOpen />}
            title="Dossier de sortie"
            description="Le ZIP généré sera écrit dans le dossier choisi."
          />
          <div className="aggregate-output-card">
            <span className="aggregate-pack-icon"><FolderOpen /></span>
            <span className="aggregate-pack-copy">
              <span className="aggregate-output-path" title={outputDir}>{outputDir || 'Aucun dossier sélectionné'}</span>
              <span className="aggregate-pack-meta">Dernière destination mémorisée</span>
            </span>
            <FunnelToolButton icon={<FolderOpen />} accent="neutral" onClick={handlePickOutputDir}>
              Changer…
            </FunnelToolButton>
          </div>
          <div className="aggregate-filename-well">
            <Package />
            <span title={joinPath(outputDir, outputFileName)}>{outputFileName}</span>
            <small>{formatBytes(totalSize) || 'Taille estimée après génération'}</small>
          </div>
          {error && <div className="funnel-error" role="alert">{error}</div>}
        </div>
      )}

      {phase === 'collect' && step === 4 && (
        <div className="funnel-step-content aggregate-step aggregate-metadata-step">
          <FunnelSectionHeader
            icon={<Package />}
            title="Métadonnées"
            description="Panneau PackNameModal pré-rempli, cohérent avec Modifier un pack."
            trailing={<span className="funnel-badge">Pré-rempli</span>}
          />
          <div className="aggregate-harmonize-row">
            <span className="aggregate-harmonize-icon"><Check /></span>
            <span className="aggregate-harmonize-copy">
              <strong>Harmoniser le volume</strong>
              <small>Normalise le niveau sonore entre tous les packs agrégés.</small>
            </span>
            <button
              type="button"
              className={`aggregate-switch${harmonizeLoudness ? ' is-on' : ''}`}
              role="switch"
              aria-checked={harmonizeLoudness}
              onClick={() => setHarmonizeLoudness((value) => !value)}
            >
              <span />
            </button>
          </div>
          <Suspense fallback={null}>
            <PackNameModal
              open
              embedded
              packMetadata={metadata}
              project={previewProject}
              coverImage={rootImage}
              exportFolder={outputDir}
              generateDisabled={!outputDir}
              onSave={saveMetadataDraft}
              onSaveAndGenerate={saveMetadataAndGenerate}
              onClose={() => setStep(3)}
            />
          </Suspense>
          {error && <div className="funnel-error" role="alert">{error}</div>}
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
            savePath={null}
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
            label="Audio du menu"
            initialText={metadata.title || 'Mes histoires du soir'}
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
            defaultText={metadata.title || 'Mes histoires du soir'}
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
