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
  MENU_DEPTH_LIMIT_REACHED_MESSAGE,
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
import { formatFrenchCount } from '../utils/frenchText.js';
import { logger } from '../utils/logger';
import { errorMessage, isYoutubeBlocked, youtubeErrorCode } from '../utils/youtubeErrors.js';
import { FREE_EDITOR_REFUSAL_MESSAGE, isFreeEditorRefusal } from '../components/EditPack/importErrorPresentation';

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
      ...unresolvedTransitions,
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
  showErrorDialog,
  getImportDisplayName,
  isImportedPackPath,
  onImportedPackPromoted,
}) {
  const dispatchFiles = useCallback(async (menuId, files) => {
    for (let index = 0; index < files.length; index += 1) {
      const f = files[index];
      const displayName = getImportDisplayName(f);
      setImporting({
        name: displayName,
        index: index + 1,
        total: files.length,
        phase: isImportedPackPath(f)
          ? "Analyse du pack importé..."
          : "Import de l'audio...",
      });

      const file = await maybeCopyToProject(f);
      if (isImportedPackPath(file)) {
        let zipTitle = null;
        let zipCoverImage = null;
        let zipCoverAudio = null;
        try {
          setImporting({
            name: displayName,
            index: index + 1,
            total: files.length,
            phase: 'Lecture des métadonnées du pack...',
          });
          const json = await invoke('load_pack_zip', { zipPath: file });
          const data = JSON.parse(json);
          zipTitle = sanitizeImportedName(data.title?.trim(), null);
          const sq = (data.stageNodes || []).find(n => n.squareOne === true);
          zipCoverImage = sq?.image || null;
          zipCoverAudio = sq?.audio || null;
        } catch (e) {
          showErrorDialog({
            title: 'Archive invalide',
            message: `Archive importée invalide ou inaccessible : ${file}\n\n${e}`,
          });
          continue;
        }
        store.addZip(menuId, file, zipTitle, zipCoverImage, zipCoverAudio);
      } else {
        setImporting({
          name: displayName,
          index: index + 1,
          total: files.length,
          phase: "Analyse de l'audio importé...",
        });
        const embeddedImage = await extractAudioEmbeddedImage(file);
        const storyId = store.addStory(menuId, file);
        if (embeddedImage && storyId) store.updateItem(storyId, { itemImage: embeddedImage });
      }
    }
  }, [extractAudioEmbeddedImage, getImportDisplayName, isImportedPackPath, maybeCopyToProject, setImporting, showErrorDialog, store]);

  const handleAddStory = useCallback(async () => {
    const files = await pickMultipleAudioOrZip();
    if (files.length === 0) return;
    logger.info(`import:pick-root count=${files.length}`);
    setImporting({
      name: getImportDisplayName(files[0]),
      index: 0,
      total: files.length,
      phase: "Préparation de l'import...",
    });
    try {
      await dispatchFiles(null, files);
    } finally {
      setImporting(null);
    }
  }, [dispatchFiles, getImportDisplayName, setImporting]);

  const handleAddStoryToMenu = useCallback(async (menuId) => {
    const files = await pickMultipleAudioOrZip();
    if (files.length === 0) return;
    setImporting({
      name: getImportDisplayName(files[0]),
      index: 0,
      total: files.length,
      phase: "Préparation de l'import...",
    });
    try {
      await dispatchFiles(menuId ?? null, files);
    } finally {
      setImporting(null);
    }
  }, [dispatchFiles, getImportDisplayName, setImporting]);

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

  async function processFolderNode(node, parentMenuId, counter, total) {
    if (node.type === 'folder') {
      const menuId = store.addMenu(parentMenuId);
      if (!menuId) throw new Error(MENU_DEPTH_LIMIT_REACHED_MESSAGE);
      store.updateMenu(menuId, { name: node.name });
      for (const child of (node.children ?? [])) {
        await processFolderNode(child, menuId, counter, total);
      }
    } else if (node.type === 'audio') {
      counter.value += 1;
      setImporting({ name: node.name, index: counter.value, total, phase: "Import de l'audio..." });
      const copiedPath = await maybeCopyToProject(node.path);
      const embeddedImage = await extractAudioEmbeddedImage(copiedPath);
      const storyId = store.addStory(parentMenuId, copiedPath);
      if (embeddedImage) store.updateItem(storyId, { itemImage: embeddedImage });
    } else if (node.type === 'zip') {
      counter.value += 1;
      setImporting({ name: node.name, index: counter.value, total, phase: "Import de l'archive..." });
      const copiedPath = await maybeCopyToProject(node.path);
      store.addZip(parentMenuId, copiedPath, null, null, null);
    }
  }

  async function handleImportFolder(targetMenuId = null) {
    const folderPath = await pickFolder();
    if (!folderPath) return;
    logger.info(`import-folder:start path='${folderPath}' targetMenuId=${targetMenuId ?? 'root'}`);
    let tree;
    try {
      tree = await invoke('scan_import_folder', { folderPath });
    } catch (e) {
      logger.error(`import-folder:scan-error path='${folderPath}' error=${e}`);
      showErrorDialog({
        title: 'Import dossier',
        message: `Impossible de lire le dossier : ${e}`,
      });
      return;
    }
    const total = countFolderFiles(tree);
    if (total === 0) {
      logger.warn(`import-folder:empty path='${folderPath}'`);
      showErrorDialog({
        title: 'Import dossier',
        message: 'Aucun fichier audio ou archive trouvé dans ce dossier.',
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
        title: 'Limite d’imbrication',
        message: MENU_DEPTH_LIMIT_REACHED_MESSAGE,
      });
      return;
    }
    logger.info(`import-folder:found count=${total}`);
    setImporting({ name: tree.name, index: 0, total, phase: 'Analyse du dossier...' });
    try {
      await processFolderNode(tree, targetMenuId, { value: 0 }, total);
    } finally {
      setImporting(null);
    }
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
    const baseProject = store.project;
    const savePath = store.savePath;
    const currentZipItem = findEntryById(baseProject, itemId) ?? zipItem;
    if (!currentZipItem?.zipPath) return;

    // Hors session, l'extraction va dans l'emplacement de travail, jamais à
    // côté du `.mbah`.
    const wsDir = workspaceDirRef.current || await getWorkspaceDir().catch(() => '');
    if (!wsDir) {
      showErrorDialog({
        title: 'Extraction du pack',
        message: "Aucun espace de travail n'est disponible pour extraire ce pack.",
      });
      return;
    }

    setUnpacking({ name: currentZipItem.name || 'ZIP en cours' });
    try {
      const extractedDirName = sanitizeImportedName(currentZipItem.name || itemId, itemId).replace(/[/\\:*?"<>|]/g, '_');
      const destDir = `${getExtractedZipsDir(wsDir)}/${extractedDirName}`;
      const result = await invoke('unpack_zip_to_entries', {
        zipPath: currentZipItem.zipPath,
        destDir,
        workspaceDir: wsDir,
      });
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
          title: 'Extraction du pack',
          message: 'Aucune entrée trouvée dans ce ZIP.',
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
        const firstWarning = transformed.unresolvedTransitions[0]?.message;
        notices.push(
          "Certaines transitions du pack importé n'ont pas pu être modélisées complètement. "
          + "Story Studio a conservé la structure reconnue, mais vérifie les retours concernés avant export."
          + (firstWarning ? ` Exemple : ${firstWarning}` : '')
        );
      }
      if (transformed.autoNextNotAdopted) {
        notices.push("Ce pack enchaînait ses histoires ; ce réglage n'a pas été repris.");
      }
      if (notices.length) setImportNotice(notices.join('\n\n'));
    } catch (e) {
      if (isFreeEditorRefusal(e)) {
        showErrorDialog({
          title: 'Extraction du pack',
          message: FREE_EDITOR_REFUSAL_MESSAGE,
          variant: 'warning',
        });
        return;
      }
      showErrorDialog({
        title: e?.code === 'menu_depth_limit' ? 'Limite d’imbrication' : 'Extraction du pack',
        message: e?.code === 'menu_depth_limit'
          ? e.message
          : `Erreur lors de l'extraction : ${e}`,
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
  }) {
    const extractedDirName = sanitizeImportedName(zipName || zipPath, zipPath).replace(/[/\\:*?"<>|]/g, '_');
    const destDir = `${getExtractedZipsDir(workspaceDir)}/${extractedDirName}`;
    const result = await invoke('unpack_zip_to_entries', {
      zipPath,
      destDir,
      workspaceDir,
    });
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
    const files = await pickMultipleMediaFiles();
    if (files.length === 0) return;
    const total = files.length;
    setImporting({ name: basename(files[0]) || files[0], index: 0, total, phase: "Préparation de l'import..." });
    try {
      const nextPaths = await importFilesToMediaLibrary({
        files,
        maybeCopyToProject,
        copyGeneratedMediaToProject,
        extractAudioEmbeddedImage,
        setImporting,
        getImportDisplayName: (path) => basename(path) || path,
      });
      addPathsToMediaLibrary(nextPaths);
    } finally {
      setImporting(null);
    }
  }

  async function handleImportMediaLibraryFolder() {
    const folderPath = await pickFolder();
    if (!folderPath) return;
    try {
      const files = await invoke('list_folder_media_files', { folderPath });
      if (!files.length) return;
      const total = files.length;
      const folderName = basename(folderPath) || folderPath;
      setImporting({ name: folderName, index: 0, total, phase: 'Scan du dossier...' });
      const nextPaths = await importFilesToMediaLibrary({
        files,
        maybeCopyToProject,
        copyGeneratedMediaToProject,
        extractAudioEmbeddedImage,
        setImporting,
        getImportDisplayName: (path) => basename(path) || path,
      });
      addPathsToMediaLibrary(nextPaths);
    } catch (e) {
      logger.error('media-library:import-folder-error', e);
    } finally {
      setImporting(null);
    }
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
    const toLibrary = landing === MEDIA_LANDING_LIBRARY;
    const report = onProgress ?? setImporting;
    const isYoutube = source === 'youtube';
    const itemLabel = isYoutube ? 'vidéo' : 'épisode';

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
    report({ name: feedTitle, index: 0, total, phase: "Préparation de l'import..." });

    let failures = 0;
    let skipped = 0;
    let blocked = false;
    let firstError = null;
    let firstErrorCode = null;
    const importedPaths = [];
    try {
      for (let index = 0; index < episodes.length; index += 1) {
        const episode = episodes[index];
        const displayName = episode.title || `${isYoutube ? 'Vidéo' : 'Épisode'} ${index + 1}`;
        try {
          report({ name: displayName, index: index + 1, total, phase: `Téléchargement de la ${itemLabel}...` });
          const tmpAudio = await downloadEntryAudio(source, episode, displayName);
          const audio = await copyGeneratedMediaToProject(tmpAudio);

          let itemImage = null;
          const imageUrl = episode.imageUrl || feedImage;
          if (imageUrl) {
            report({ name: displayName, index: index + 1, total, phase: 'Récupération de la vignette...' });
            try {
              // download_podcast_media est un téléchargeur HTTP générique : il sert
              // aussi à récupérer les miniatures YouTube.
              const tmpImage = await invoke('download_podcast_media', { url: imageUrl, fileName: `${displayName}-vignette` });
              itemImage = await copyGeneratedMediaToProject(tmpImage);
            } catch (imageError) {
              logger.warn(`import-media:cover-error source=${source} name='${displayName}' error=${imageError}`);
            }
          }
          if (!itemImage) {
            itemImage = await extractAudioEmbeddedImage(audio);
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
        } catch (episodeError) {
          failures += 1;
          logger.error(`import-media:item-error source=${source} name='${displayName}' error=${errorMessage(episodeError)}`);
          if (isYoutube && isYoutubeBlocked(episodeError)) {
            // La cause du blocage prime : elle explique aussi l'arrêt du lot.
            blocked = true;
            firstError = errorMessage(episodeError);
            firstErrorCode = youtubeErrorCode(episodeError);
            skipped = total - index - 1;
            failures += skipped;
            logger.warn(`import-media:blocked source=${source} skipped=${skipped}`);
            break;
          }
          if (firstError === null) {
            firstError = errorMessage(episodeError);
            firstErrorCode = youtubeErrorCode(episodeError);
          }
        }
      }
    } finally {
      // Ne nettoie que la modale globale ; le funnel gère lui-même son écran.
      if (!onProgress) setImporting(null);
    }

    if (failures > 0 && !suppressDialog) {
      showErrorDialog({
        title: isYoutube ? 'Import YouTube' : 'Import du podcast',
        message: failures === total
          ? `Aucune ${itemLabel} n'a pu être importée. Vérifie ta connexion ou l'adresse ${isYoutube ? 'YouTube' : 'du flux'}.`
          : `${formatFrenchCount(failures, itemLabel, `${itemLabel}s`)} sur ${total} n'ont pas pu être ${isYoutube ? 'importées' : 'importés'}. Les autres ont bien été ${isYoutube ? 'ajoutées' : 'ajoutés'}.`,
        variant: failures === total ? 'warning' : 'info',
      });
    }

    return {
      total, failures, imported: total - failures, skipped, blocked,
      firstError, firstErrorCode, importedPaths,
    };
  }

  return {
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
