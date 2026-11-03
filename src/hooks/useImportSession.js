import { translateImport as t, importPresentationError } from '../i18n/importPresentation.js';
import { presentUserMessage } from '../i18n/userMessage.js';
import { beginProjectMediaOutput, withProjectMediaOutput } from '../store/projectMediaOutput';
import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  getExtractedZipsDir,
  getWorkspaceDir,
} from '../store/projectIO';
import {
  sanitizeImportedEntries,
  sanitizeImportedName,
} from '../store/projectStore';
import {
  MENU_DEPTH_LIMIT_REACHED_REF,
  MENU_DEPTH_LIMIT_TITLE_REF,
  findEntryById,
  validateMenuHeightPlacement,
} from '../store/projectModel';
import { buildProjectAfterZipUnpack } from '../store/unpackProject';
import { authoringWorkspaceMode } from '../store/projectWorkState';
import {
  MEDIA_LANDING_LIBRARY,
  mediaToolLanding,
  planProducedMediaLanding,
} from '../store/mediaToolSurface';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { pickFolder, pickMultipleAudioOrZip, pickMultipleMediaFiles } from './useFileDialog';
import { importFilesToMediaLibrary } from './mediaLibraryImport';
import { basename } from '../utils/fileUtils';
import { keepFolderPackInProject } from '../utils/packFolder';
import { logger } from '../utils/logger';
import { errorMessage, isYoutubeBlocked, youtubeErrorCode } from '../utils/youtubeErrors.js';
import { isFreeEditorRefusal } from '../components/EditPack/importErrorPresentation';

/**
 * Construit le projet résultant d'une extraction de ZIP à partir du résultat
 * Rust (`unpack_zip_to_entries`). Pur (aucune I/O, aucun store) : applique la
 * promotion en pack, les avertissements de transitions, autoNext et night-mode.
 * Réutilisé par l'extraction manuelle (`handleUnpackZip`) et par l'entrée
 * « Modifier un pack » (session éphémère). Retourne `null` si le pack ne
 * contient aucune entrée.
 */
function projectFromUnpackResult({
  baseProject,
  menuId = null,
  itemId = null,
  zipPath = '',
  zipName = '',
  result = {},
  savedDuringUnpack = false,
}) {
  const entries = sanitizeImportedEntries(result?.entries ?? []);
  if (!entries.length) return null;

  const unpacked = buildProjectAfterZipUnpack({
    project: baseProject,
    menuId,
    itemId,
    entries,
    zipPath,
    zipName,
    result,
    savedDuringUnpack,
  });
  let nextProject = unpacked.project;
  const unresolvedTransitions = Array.isArray(result?.unresolvedTransitions)
    ? result.unresolvedTransitions.map((warning) => ({
        ...warning,
        sourceRootId: result?.rootId ?? null,
        sourceName: unpacked.packName,
      }))
    : [];
  nextProject = {
    ...nextProject,
    importWarnings: [
      ...(nextProject.importWarnings ?? []).filter((warning) => warning?.sourceRootId !== result?.rootId),
      ...unresolvedTransitions.map(({ userMessage: _userMessage, ...warning }) => warning),
    ],
  };
  if (unpacked.promoted && result?.autoNext) {
    nextProject = {
      ...nextProject,
      globalOptions: { ...nextProject.globalOptions, autoNext: true, nightMode: false },
    };
  }
  // Le message de fin partagé est repris même sans mode nuit : l'original le
  // joue après chaque histoire. `nightMode` reste ce que le pack déclare.
  // Réglage global : il n'est repris que lorsque le pack devient le projet
  // (promotion d'un projet vierge). Extrait dans un parent non vierge, il
  // s'appliquerait aussi aux histoires du parent, qui n'en ont jamais eu.
  if (
    unpacked.promoted
    && result?.nightModeAudio
    && !result?.autoNext
    && !nextProject.globalOptions?.nightMode
    && !nextProject.nightModeAudio
  ) {
    nextProject = {
      ...nextProject,
      nightModeAudio: result.nightModeAudio,
      nightModeReturn: result.nightModeReturn ?? null,
      nightModeHomeReturn: result.nightModeHomeReturn ?? null,
      globalOptions: {
        ...nextProject.globalOptions,
        nightMode: !!result.nightMode,
        endMessageAutoplay: typeof result?.endMessageAutoplay === 'boolean'
          ? result.endMessageAutoplay
          : true,
      },
    };
  }
  return {
    project: nextProject,
    packName: unpacked.packName,
    promoted: unpacked.promoted,
    autoNextNotAdopted: !!result?.autoNext && !unpacked.promoted,
    unresolvedTransitions,
    advancedTransitionsDetected: !!result?.advancedTransitionsDetected,
  };
}

export function useImportSession({
  store,
  projectIndex,
  maybeCopyToProject,
  copyGeneratedMediaToProject,
  extractAudioEmbeddedImage,
  setImporting,
  setUnpacking,
  setImportNotice,
  addPathsToMediaLibrary,
  persistProjectSnapshot,
  workspaceDirRef,
  mediaStorageRef = null,
  sessionModeRef = null,
  showErrorDialog,
  getImportDisplayName,
  isImportedPackPath,
  onImportedPackPromoted,
}) {
  const captureImport = useCallback(() => {
    const project = store.readProject?.() ?? store.project;
    const epoch = store.workEpochRef?.current;
    const mediaStorage = {
      ...(mediaStorageRef?.current ?? {}), root: workspaceDirRef?.current ?? '',
      storage: project.storage, ephemeral: sessionModeRef?.current !== 'project',
    };
    const mediaOutput = mediaStorage.root ? beginProjectMediaOutput(mediaStorage) : null;
    return {
      copies: { mediaStorage, mediaOutput },
      isCurrent: () => (epoch == null || store.workEpochRef.current === epoch)
        && workspaceDirRef?.current === mediaStorage.root
        && (sessionModeRef?.current !== 'project') === mediaStorage.ephemeral,
      release: () => mediaOutput?.release(),
    };
  }, [mediaStorageRef, sessionModeRef, store, workspaceDirRef]);

  // `folders` : chemins de `files` qui sont des dossiers (type réel lu par le moteur).
  // Un dossier de pack vaut une archive : converti par le lecteur unique, puis
  // rangé avec les fichiers importés (le cache applicatif est purgé après un
  // jour) et traité comme le `.zip` qu'il est devenu.
  const dispatchFiles = useCallback(async (menuId, files, capturedRequest = null, { folders = null } = {}) => {
    const request = capturedRequest ?? captureImport();
    const folderSet = new Set(folders ?? []);
    // Un dépôt de plusieurs dossiers invalides donne un seul message, pas une rafale.
    const folderFailures = [];
    try {
      for (let index = 0; index < files.length; index += 1) {
        const f = files[index];
        const displayName = getImportDisplayName(f);
        setImporting({
          name: displayName,
          index: index + 1,
          total: files.length,
          get phase() {
            if (folderSet.has(f)) return t('import:folder.analysis.progress');
            return isImportedPackPath(f) ? t('import:pack.analysis.progress') : t('import:audio.import.progress');
          },
        });

        let file;
        if (folderSet.has(f)) {
          try {
            file = await keepFolderPackInProject(f, (staged) => copyGeneratedMediaToProject(staged, request.copies), {
              isCurrent: request.isCurrent,
              workspaceDir: request.copies.mediaStorage.root,
            });
            if (!file) break;
          } catch (e) {
            folderFailures.push({ path: f, error: e });
            continue;
          }
        } else {
          file = await maybeCopyToProject(f, request.copies);
        }
        if (isImportedPackPath(file)) {
          let zipTitle = null;
          let zipCoverImage = null;
          let zipCoverAudio = null;
          let zipIdentity = {};
          try {
            setImporting({
              name: displayName,
              index: index + 1,
              total: files.length,
              get phase() { return t('import:pack.metadata.progress'); },
            });
            const json = await invoke('load_pack_zip', { zipPath: file });
            const data = JSON.parse(json);
            zipTitle = sanitizeImportedName(data.title?.trim(), null);
            const sq = (data.stageNodes || []).find(n => n.squareOne === true);
            zipCoverImage = sq?.image || null;
            zipCoverAudio = sq?.audio || null;
            zipIdentity = { packUuid: sq?.uuid || data.uuid || '', officialProvenance: data.officialProvenance ?? 'unknown', ...(data.officialOriginUuid ? { officialOriginUuid: data.officialOriginUuid } : {}) };
          } catch (e) {
            const presented = presentUserMessage(e);
            showErrorDialog({
              get title() { return t('import:pack.invalid.title'); },
              get message() { return t('import:pack.invalid.message', { path: file, reason: presentUserMessage(e).message }); },
              technicalDetail: presented.technicalDetail,
            });
            continue;
          }
          if (!request.isCurrent()) break;
          store.addZip(menuId, file, zipTitle, zipCoverImage, zipCoverAudio, zipIdentity);
        } else {
          setImporting({
            name: displayName,
            index: index + 1,
            total: files.length,
            get phase() { return t('import:audio.analysis.progress'); },
          });
          const embeddedImage = await extractAudioEmbeddedImage(file);
          if (!request.isCurrent()) break;
          const storyId = store.addStory(menuId, file);
          if (embeddedImage && storyId) store.updateItem(storyId, { itemImage: embeddedImage });
        }
      }
      if (folderFailures.length > 0 && request.isCurrent()) {
        const details = folderFailures.map(({ error }) => presentUserMessage(error).technicalDetail).filter(Boolean);
        showErrorDialog({
          get title() { return t('import:folder.import.title'); },
          get message() {
            return folderFailures
              .map(({ path, error }) => t('import:folder.pack.invalid.message', { path, reason: presentUserMessage(error).message }))
              .join('\n\n');
          },
          technicalDetail: details.join('\n\n'),
        });
      }
    } finally { request.release(); }
  }, [captureImport, copyGeneratedMediaToProject, extractAudioEmbeddedImage, getImportDisplayName, isImportedPackPath, maybeCopyToProject, setImporting, showErrorDialog, store]);

  const handleAddStory = useCallback(async () => {
    const request = captureImport();
    try {
      const files = await pickMultipleAudioOrZip();
      if (files.length === 0) return;
      logger.info(`import:pick-root count=${files.length}`);
      setImporting({
        name: getImportDisplayName(files[0]),
        index: 0,
        total: files.length,
        get phase() { return t('import:media.preparation.progress'); },
      });
      try {
        await dispatchFiles(null, files, request);
      } finally {
        setImporting(null);
      }
    } finally { request.release(); }
  }, [captureImport, dispatchFiles, getImportDisplayName, setImporting]);

  const handleAddStoryToMenu = useCallback(async (menuId) => {
    const request = captureImport();
    try {
      const files = await pickMultipleAudioOrZip();
      if (files.length === 0) return;
      setImporting({
        name: getImportDisplayName(files[0]),
        index: 0,
        total: files.length,
        get phase() { return t('import:media.preparation.progress'); },
      });
      try {
        await dispatchFiles(menuId ?? null, files, request);
      } finally {
        setImporting(null);
      }
    } finally { request.release(); }
  }, [captureImport, dispatchFiles, getImportDisplayName, setImporting]);

  function countFolderFiles(node) {
    if (node.type === 'folder') return (node.children ?? []).reduce((s, c) => s + countFolderFiles(c), 0);
    return 1;
  }

  function getImportFolderMenuHeight(node) {
    if (!node || typeof node !== 'object') return 0;
    const stack = [{ node, parentHeight: 0 }];
    let height = 0;
    while (stack.length > 0) {
      const current = stack.pop();
      const isFolder = current.node?.type === 'folder';
      const currentHeight = current.parentHeight + (isFolder ? 1 : 0);
      height = Math.max(height, currentHeight);
      if (!isFolder) continue;
      for (const child of current.node.children ?? []) {
        stack.push({ node: child, parentHeight: currentHeight });
      }
    }
    return height;
  }

  async function processFolderNode(node, parentMenuId, counter, total, request) {
    if (!request.isCurrent()) return;
    if (node.type === 'folder') {
      const menuId = store.addMenu(parentMenuId);
      if (!menuId) throw importPresentationError(MENU_DEPTH_LIMIT_REACHED_REF, {}, { code: 'VALIDATION_MENU_DEPTH_LIMIT' });
      store.updateMenu(menuId, { name: node.name });
      for (const child of (node.children ?? [])) {
        await processFolderNode(child, menuId, counter, total, request);
      }
    } else if (node.type === 'audio') {
      counter.value += 1;
      setImporting({ name: node.name, index: counter.value, total, get phase() { return t('import:audio.import.progress'); } });
      const copiedPath = await maybeCopyToProject(node.path, request.copies);
      const embeddedImage = await extractAudioEmbeddedImage(copiedPath);
      if (!request.isCurrent()) return;
      const storyId = store.addStory(parentMenuId, copiedPath);
      if (embeddedImage) store.updateItem(storyId, { itemImage: embeddedImage });
    } else if (node.type === 'zip') {
      counter.value += 1;
      setImporting({ name: node.name, index: counter.value, total, get phase() { return t('import:archive.import.progress'); } });
      const copiedPath = await maybeCopyToProject(node.path, request.copies);
      if (!request.isCurrent()) return;
      store.addZip(parentMenuId, copiedPath, null, null, null);
    }
  }

  async function handleImportFolder(targetMenuId = null) {
    const request = captureImport();
    try {
      const folderPath = await pickFolder();
      if (!folderPath) return;
      logger.info(`import-folder:start path='${folderPath}' targetMenuId=${targetMenuId ?? 'root'}`);
      let tree;
      try {
        tree = await invoke('scan_import_folder', { folderPath, proposedFolderName: t('import:names.folder.fallback') });
      } catch (e) {
        logger.error(`import-folder:scan-error path='${folderPath}' error=${presentUserMessage(e).message}`);
        showErrorDialog({
          get title() { return t('import:folder.import.title'); },
          message: { userMessage: e, prefix: { key: 'import:folder.read.prefix' }, suffix: `` },
        });
        return;
      }
      const total = countFolderFiles(tree);
      if (total === 0) {
        logger.warn(`import-folder:empty path='${folderPath}'`);
        showErrorDialog({
          get title() { return t('import:folder.import.title'); },
          get message() { return t('import:folder.import.empty'); },
          variant: 'info',
        });
        return;
      }
      const depthDiagnostic = validateMenuHeightPlacement(
        store.project,
        targetMenuId,
        getImportFolderMenuHeight(tree),
        projectIndex,
      );
      if (!depthDiagnostic.allowed) {
        showErrorDialog({
          title: MENU_DEPTH_LIMIT_TITLE_REF,
          message: MENU_DEPTH_LIMIT_REACHED_REF,
        });
        return;
      }
      logger.info(`import-folder:found count=${total}`);
      setImporting({ name: tree.name, index: 0, total, get phase() { return t('import:folder.analysis.progress'); } });
      try {
        await processFolderNode(tree, targetMenuId, { value: 0 }, total, request);
      } finally {
        setImporting(null);
      }
    } finally { request.release(); }
  }

  async function handleUnpackZip(itemId) {
    const zipItem = projectIndex.entryById.get(itemId) ?? null;
    if (!zipItem?.zipPath) return;
    const menuId = projectIndex.parentMenuById.get(itemId) ?? null;

    // Persistance différée : extraire un ZIP n'impose JAMAIS d'enregistrer
    // le projet. En session éphémère (savePath == null) on extrait dans le workspace
    // de session et l'autosave écrit le snapshot de récupération. Forcer un save ici
    // déclenchait la promotion via handleSaveProject, donc le nettoyage du dossier
    // de session — ce qui supprimait le ZIP source avant même son
    // extraction (« Archive introuvable »).
    const baseProject = store.readProject?.() ?? store.project;
    const workEpoch = store.workEpochRef?.current;
    const capturedStorage = { ...(mediaStorageRef?.current ?? {}), storage: baseProject.storage, ephemeral: sessionModeRef?.current !== 'project' };
    const savePath = store.savePath;
    const currentZipItem = findEntryById(baseProject, itemId) ?? zipItem;
    if (!currentZipItem?.zipPath) return;

    // Hors session, l'extraction va dans l'emplacement de travail, jamais à
    // côté du `.mbah`.
    const wsDir = workspaceDirRef.current || await getWorkspaceDir().catch(() => '');
    if (!wsDir) {
      showErrorDialog({
        get title() { return t('import:pack.extraction.title'); },
        get message() { return t('import:pack.workspace.missing'); },
      });
      return;
    }

    setUnpacking({ get name() { return currentZipItem.name || t('import:pack.zip.default'); } });
    try {
      const extractedDirName = sanitizeImportedName(currentZipItem.name || itemId, itemId).replace(/[/\\:*?"<>|]/g, '_');
      const destDir = `${getExtractedZipsDir(wsDir)}/${extractedDirName}`;
      const result = await withProjectMediaOutput({ ...capturedStorage, root: wsDir }, async (output) => invoke('unpack_zip_to_entries', {
        zipPath: currentZipItem.zipPath, destDir, proposedPackName: t('import:names.pack.fallback'), ...await output.arguments(),
      }));
      if (workEpoch != null && store.workEpochRef.current !== workEpoch) return;
      const transformed = projectFromUnpackResult({
        baseProject,
        menuId,
        itemId,
        zipPath: currentZipItem.zipPath,
        zipName: currentZipItem.name,
        result,
        savedDuringUnpack: false,
      });
      if (!transformed) {
        showErrorDialog({
          get title() { return t('import:pack.extraction.title'); },
          get message() { return t('import:pack.entries.empty'); },
          variant: 'warning',
        });
        return;
      }
      const depthOutcome = store.setProjectWithDepthGuard(transformed.project);
      if (!depthOutcome.allowed) return;
      store.setSelectedId('root');
      // Extraire un pack qui promeut le projet vierge = importer un pack à modifier :
      // on marque la méta comme « à confirmer » pour que la génération force la modal
      // et propose de régénérer l'UUID (nouvelle révision), comme « Modifier un pack ».
      if (transformed.promoted) onImportedPackPromoted?.();
      // Projet déjà enregistré : autosave .mbah immédiat. Éphémère/non-enregistré :
      // pas de save forcé, le snapshot de session suit via l'autosave.
      if (savePath) {
        await persistProjectSnapshot(transformed.project, savePath);
      }
      const notices = [];
      if (transformed.advancedTransitionsDetected) {
        const firstWarning = transformed.unresolvedTransitions[0];
        notices.push(firstWarning
          ? { key: 'import:pack.transitions.example', params: { notice: { key: 'import:pack.transitions.notice' }, example: { importWarning: firstWarning } } }
          : { key: 'import:pack.transitions.notice' });
      }
      if (transformed.autoNextNotAdopted) {
        notices.push({ key: 'import:pack.autoNext.notice' });
      }
      if (notices.length) setImportNotice({ parts: notices, separator: '\n\n' });
    } catch (e) {
      if (isFreeEditorRefusal(e)) {
        showErrorDialog({
          get title() { return t('import:pack.extraction.title'); },
          get message() { return presentUserMessage(e).message; },
          technicalDetail: presentUserMessage(e).technicalDetail,
          variant: 'warning',
        });
        return;
      }
      const presented = presentUserMessage(e);
      showErrorDialog({
        technicalDetail: presented.technicalDetail,
        get title() { return e?.code === 'VALIDATION_MENU_DEPTH_LIMIT' ? MENU_DEPTH_LIMIT_TITLE_REF : t('import:pack.extraction.title'); },
        get message() { return e?.code === 'VALIDATION_MENU_DEPTH_LIMIT'
          ? { userMessage: e }
          : t('import:pack.extraction.message', { reason: presentUserMessage(e).message }); },
      });
    } finally {
      setUnpacking(null);
    }
  }

  // Extrait un pack dans un projet de session vierge (« Modifier un pack ») :
  // aucune sauvegarde forcée, l'écriture va dans le dossier de
  // session. Retourne le projet promu (ou `null` si aucune entrée). L'appelant
  // (App.jsx) gère le store et la persistance éphémère.
  async function unpackZipIntoBlankProject({
    zipPath,
    zipName,
    workspaceDir,
    baseProject,
    ephemeral = true,
  }) {
    const extractedDirName = sanitizeImportedName(zipName || zipPath, zipPath).replace(/[/\\:*?"<>|]/g, '_');
    const destDir = `${getExtractedZipsDir(workspaceDir)}/${extractedDirName}`;
    const result = await withProjectMediaOutput({ root: workspaceDir, storage: baseProject.storage, ephemeral }, async (output) => invoke('unpack_zip_to_entries', {
      zipPath, destDir, proposedPackName: t('import:names.pack.fallback'), ...await output.arguments(),
    }));
    return projectFromUnpackResult({
      baseProject,
      menuId: null,
      itemId: null,
      zipPath,
      zipName,
      result,
      savedDuringUnpack: false,
    });
  }

  async function handleImportMediaLibrary() {
    const request = captureImport();
    try {
      const files = await pickMultipleMediaFiles();
      if (files.length === 0) return;
      const total = files.length;
      setImporting({ name: basename(files[0]) || files[0], index: 0, total, get phase() { return t('import:media.preparation.progress'); } });
      try {
        const nextPaths = await importFilesToMediaLibrary({
          files,
          maybeCopyToProject: (path) => maybeCopyToProject(path, request.copies),
          copyGeneratedMediaToProject: (path) => copyGeneratedMediaToProject(path, request.copies),
          extractAudioEmbeddedImage,
          setImporting,
          getImportDisplayName: (path) => basename(path) || path,
        });
        if (request.isCurrent()) addPathsToMediaLibrary(nextPaths);
      } finally {
        setImporting(null);
      }
    } finally { request.release(); }
  }

  async function handleImportMediaLibraryFolder() {
    const request = captureImport();
    try {
      const folderPath = await pickFolder();
      if (!folderPath) return;
      try {
        const files = await invoke('list_folder_media_files', { folderPath });
        if (!files.length) return;
        const total = files.length;
        const folderName = basename(folderPath) || folderPath;
        setImporting({ name: folderName, index: 0, total, get phase() { return t('import:folder.scan.progress'); } });
        const nextPaths = await importFilesToMediaLibrary({
          files,
          maybeCopyToProject: (path) => maybeCopyToProject(path, request.copies),
          copyGeneratedMediaToProject: (path) => copyGeneratedMediaToProject(path, request.copies),
          extractAudioEmbeddedImage,
          setImporting,
          getImportDisplayName: (path) => basename(path) || path,
        });
        if (request.isCurrent()) addPathsToMediaLibrary(nextPaths);
      } catch (e) {
        logger.error('media-library:import-folder-error', e);
      } finally {
        setImporting(null);
      }
    } finally { request.release(); }
  }

  // Télécharge l'audio d'une entrée selon sa source et renvoie un chemin temp.
  // Podcast : flux direct (`download_podcast_media`). YouTube : via yt-dlp
  // (`download_youtube_audio`, qui extrait le MP3 avec le ffmpeg embarqué).
  async function downloadEntryAudio(source, entry, displayName) {
    if (source === 'youtube') {
      const ytdlpPath = readSetting(KEYS.YTDLP_CUSTOM_PATH, { defaultValue: '' });
      return invoke('download_youtube_audio', {
        videoUrl: entry.audioUrl,
        fileName: displayName,
        ytdlpPath,
        audioLanguage: entry.audioLanguage || null,
      });
    }
    return invoke('download_podcast_media', { url: entry.audioUrl, fileName: displayName });
  }

  // Importe une liste d'entrées média (podcast ou YouTube) en histoires.
  // Source-agnostique : le funnel podcast, la modale podcast historique
  // et le funnel YouTube partagent ce gestionnaire. Les entrées exposent un
  // format commun (`title`, `audioUrl`, `imageUrl`) ; seul le téléchargement audio
  // diffère (`options.source`).
  // `options` :
  //   - `source` : 'podcast' (défaut) | 'youtube'.
  //   - `targetMenuId` : menu cible explicite (`null` = racine). Si absent, on
  //     déduit la cible de la sélection courante (comportement éditeur).
  //   - `onProgress` : reçoit la progression à la place de la modale globale
  //     `setImporting` (le funnel l'affiche dans son propre écran).
  //   - `suppressDialog` : laisse l'appelant signaler l'échec lui-même.
  //   - `landing` : point d'arrivée. Par défaut, celui de l'éditeur
  //     ouvert — l'arbre côté Libre, la bibliothèque côté graphe. Les funnels
  //     d'accueil créent une session de pack et retombent donc sur l'arbre
  //     sans avoir à le dire.
  // Retourne aussi les chemins réellement importés (audio et jaquette), pour
  // que la bibliothèque puisse révéler ces fichiers sans deviner leurs noms.
  // Un blocage YouTube interrompt le lot (`blocked`) : les vidéos restantes
  // (`skipped`) ne sont pas tentées, chaque requête prolongeant le blocage.
  async function handleImportMediaEpisodes(episodes, feed, options = {}) {
    if (!Array.isArray(episodes) || episodes.length === 0) {
      return {
        total: 0, failures: 0, imported: 0, skipped: 0, blocked: false,
        firstError: null, firstErrorCode: null, importedPaths: [],
      };
    }

    const {
      source = 'podcast',
      targetMenuId: explicitTargetMenuId,
      onProgress = null,
      suppressDialog = false,
      landing = mediaToolLanding(authoringWorkspaceMode(store.project)),
    } = options;
    const request = captureImport();
    const toLibrary = landing === MEDIA_LANDING_LIBRARY;
    const report = onProgress ?? setImporting;
    const isYoutube = source === 'youtube';

    // La cible d'arbre n'est déduite que lorsqu'il y a un arbre : sur un
    // document de graphe, la sélection courante désigne un Écran, qui n'est
    // pas un dossier et ne doit surtout pas en tenir lieu.
    let targetMenuId = null;
    if (!toLibrary) {
      if (explicitTargetMenuId !== undefined) {
        targetMenuId = explicitTargetMenuId;
      } else {
        const selectedId = store.selectedId;
        const selectedNode = selectedId ? projectIndex.entryById.get(selectedId) : null;
        targetMenuId = selectedNode?.type === 'menu'
          ? selectedNode.id
          : (selectedId ? (projectIndex.parentMenuById.get(selectedId) ?? null) : null);
      }
    }

    const total = episodes.length;
    const feedTitle = feed?.title || (isYoutube ? 'YouTube' : 'Podcast');
    const feedImage = feed?.imageUrl || null;
    logger.info(`import-media:start source=${source} count=${total} landing=${landing} target=${toLibrary ? 'library' : (targetMenuId ?? 'root')}`);
    report({ name: feedTitle, index: 0, total, get phase() { return t('import:media.preparation.progress'); } });

    let failures = 0;
    let skipped = 0;
    let blocked = false;
    let firstError = null;
    let firstErrorCode = null;
    const importedPaths = [];
    const importedEpisodeIds = [];
    try {
      for (let index = 0; index < episodes.length; index += 1) {
        const episode = episodes[index];
        const displayName = episode.title || (isYoutube ? t('import:names.video.numbered', { number: index + 1 }) : t('import:names.episode.numbered', { number: index + 1 }));
        try {
          report({ name: displayName, index: index + 1, total, get phase() { return isYoutube ? t('import:youtube.download.progress') : t('import:podcast.download.progress'); } });
          const tmpAudio = await downloadEntryAudio(source, episode, displayName);
          const audio = await copyGeneratedMediaToProject(tmpAudio, request.copies);

          let itemImage = null;
          const imageUrl = episode.imageUrl || feedImage;
          if (imageUrl) {
            report({ name: displayName, index: index + 1, total, get phase() { return t('import:media.thumbnail.progress'); } });
            try {
              // download_podcast_media est un téléchargeur HTTP générique : il sert
              // aussi à récupérer les miniatures YouTube.
              const tmpImage = await invoke('download_podcast_media', { url: imageUrl, fileName: `${displayName}-vignette` });
              itemImage = await copyGeneratedMediaToProject(tmpImage, request.copies);
            } catch (imageError) {
              logger.warn(`import-media:cover-error source=${source} name='${displayName}' error=${imageError}`);
            }
          }
          if (!itemImage) {
            itemImage = await extractAudioEmbeddedImage(audio);
          }

          if (!request.isCurrent()) {
            skipped = total - index;
            failures += skipped;
            break;
          }
          const plan = planProducedMediaLanding({
            landing,
            audioPath: audio,
            imagePath: itemImage,
            targetMenuId,
          });
          if (plan.kind === MEDIA_LANDING_LIBRARY) {
            addPathsToMediaLibrary(plan.paths);
            importedPaths.push(...plan.paths);
          } else {
            const storyId = store.addStory(plan.menuId, plan.audioPath);
            if (plan.imagePath) store.updateItem(storyId, { itemImage: plan.imagePath });
          }
          importedEpisodeIds.push(episode.id);
        } catch (episodeError) {
          failures += 1;
          logger.error(`import-media:item-error source=${source} name='${displayName}' error=${errorMessage(episodeError)}`);
          if (isYoutube && isYoutubeBlocked(episodeError)) {
            // La cause du blocage prime : elle explique aussi l'arrêt du lot.
            blocked = true;
            firstError = episodeError;
            firstErrorCode = youtubeErrorCode(episodeError);
            skipped = total - index - 1;
            failures += skipped;
            logger.warn(`import-media:blocked source=${source} skipped=${skipped}`);
            break;
          }
          if (firstError === null) {
            firstError = episodeError;
            firstErrorCode = youtubeErrorCode(episodeError);
          }
        }
      }
    } finally {
      request.release();
      // Ne nettoie que la modale globale ; le funnel gère lui-même son écran.
      if (!onProgress) setImporting(null);
    }

    if (failures > 0 && !suppressDialog) {
      showErrorDialog({
        technicalDetail: firstError ? presentUserMessage(firstError).technicalDetail : '',
        get title() { return isYoutube ? t('import:youtube.import.title') : t('import:podcast.import.title'); },
        message: failures === total
          ? (isYoutube ? { key: 'import:youtube.batch.failure' } : { key: 'import:podcast.batch.failure' })
          : (isYoutube ? { key: 'import:youtube.batch.partial', params: { count: failures, total } } : { key: 'import:podcast.batch.partial', params: { count: failures, total } }),
        variant: failures === total ? 'warning' : 'info',
      });
    }

    return {
      total, failures, imported: total - failures, skipped, blocked,
      firstError, firstErrorCode, importedPaths, importedEpisodeIds,
    };
  }

  return {
    captureImport,
    dispatchFiles,
    handleAddStory,
    handleAddStoryToMenu,
    handleImportFolder,
    handleUnpackZip,
    unpackZipIntoBlankProject,
    handleImportMediaLibrary,
    handleImportMediaLibraryFolder,
    handleImportMediaEpisodes,
  };
}
