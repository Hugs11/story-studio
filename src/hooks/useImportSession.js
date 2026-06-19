import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ask } from '@tauri-apps/plugin-dialog';
import {
  getExtractedZipsDir,
} from '../store/projectIO';
import {
  sanitizeImportedEntries,
  sanitizeImportedName,
} from '../store/projectStore';
import { findEntryById } from '../store/projectModel';
import { buildProjectAfterZipUnpack } from '../store/unpackProject';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { markEntryAudioSkipSilence } from '../store/projectHelpers';
import { formatPackAudioEdgeSilence } from '../config/audioProcessing';
import { pickFolder, pickMultipleAudioOrZip, pickMultipleMediaFiles } from './useFileDialog';
import { importFilesToMediaLibrary } from './mediaLibraryImport';
import { basename } from '../utils/fileUtils';
import { logger } from '../utils/logger';

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
  handleSaveProject,
  showErrorDialog,
  getImportDisplayName,
  isImportedPackPath,
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
        if (embeddedImage) store.updateItem(storyId, { itemImage: embeddedImage });
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

  async function processFolderNode(node, parentMenuId, counter, total) {
    if (node.type === 'folder') {
      const menuId = store.addMenu(parentMenuId);
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

    let effectiveSavePath = store.savePath;
    let baseProject = store.project;
    let savedDuringUnpack = false;
    if (!effectiveSavePath) {
      const saveResult = await handleSaveProject({ returnResult: true });
      if (!saveResult?.path) return;
      effectiveSavePath = saveResult.path;
      baseProject = saveResult.project ?? baseProject;
      savedDuringUnpack = true;
    }
    const currentZipItem = findEntryById(baseProject, itemId) ?? zipItem;
    if (!currentZipItem?.zipPath) return;

    const skipSilenceForExtractedAudio = await ask(
      `Les audios d'un pack extrait contiennent souvent déjà leurs silences de début/fin. Voulez-vous exclure les audios extraits de l'ajout global de ${formatPackAudioEdgeSilence()} ?`,
      {
        title: 'Extraction du pack',
        kind: 'info',
        okLabel: 'Exclure du silence',
        cancelLabel: 'Garder le traitement global',
      }
    );

    setUnpacking({ name: currentZipItem.name || 'ZIP en cours' });
    try {
      const extractedDirName = sanitizeImportedName(currentZipItem.name || itemId, itemId).replace(/[/\\:*?"<>|]/g, '_');
      const wsDir = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }) || effectiveSavePath.replace(/[\\/][^\\/]+$/, '');
      const destDir = `${getExtractedZipsDir(wsDir)}/${extractedDirName}`;
      const result = await invoke('unpack_zip_to_entries', {
        zipPath: currentZipItem.zipPath,
        destDir,
        workspaceDir: wsDir,
      });
      const entries = sanitizeImportedEntries(result?.entries ?? []);
      if (!entries.length) {
        showErrorDialog({
          title: 'Extraction du pack',
          message: 'Aucune entrée trouvée dans ce ZIP.',
          variant: 'warning',
        });
        return;
      }

      const processedEntries = (skipSilenceForExtractedAudio
        ? entries.map(markEntryAudioSkipSilence)
        : entries);
      const unpackedProject = buildProjectAfterZipUnpack({
        project: baseProject,
        menuId,
        itemId,
        entries: processedEntries,
        zipPath: currentZipItem.zipPath,
        zipName: currentZipItem.name,
        result,
        savedDuringUnpack,
      });
      let nextProject = unpackedProject.project;
      const unresolvedTransitions = Array.isArray(result?.unresolvedTransitions)
        ? result.unresolvedTransitions.map((warning) => ({
            ...warning,
            sourceRootId: result?.rootId ?? null,
            sourceName: unpackedProject.packName,
          }))
        : [];
      nextProject = {
        ...nextProject,
        importWarnings: [
          ...(nextProject.importWarnings ?? []).filter((warning) => warning?.sourceRootId !== result?.rootId),
          ...unresolvedTransitions,
        ],
      };
      if (result?.autoNext) {
        nextProject = {
          ...nextProject,
          globalOptions: {
            ...nextProject.globalOptions,
            autoNext: true,
            nightMode: false,
          },
        };
      }
      if (result?.nightMode && result?.nightModeAudio && !nextProject.globalOptions?.nightMode && !result?.autoNext) {
        nextProject = {
          ...nextProject,
          nightModeAudio: result.nightModeAudio,
          nightModeReturn: result.nightModeReturn ?? null,
          nightModeHomeReturn: result.nightModeHomeReturn ?? null,
          audioProcessing: skipSilenceForExtractedAudio
            ? {
                ...(nextProject.audioProcessing ?? {}),
                nightModeAudio: { skipSilence: true },
              }
            : nextProject.audioProcessing,
          globalOptions: {
            ...nextProject.globalOptions,
            nightMode: true,
          },
        };
      }
      if (skipSilenceForExtractedAudio) {
        nextProject = {
          ...nextProject,
          audioProcessing: {
            ...(nextProject.audioProcessing ?? {}),
            ...(nextProject.rootAudio ? { rootAudio: { skipSilence: true } } : {}),
            ...(nextProject.nightModeAudio ? { nightModeAudio: { skipSilence: true } } : {}),
          },
        };
      }
      store.setProject(nextProject);
      store.setSelectedId('root');
      await persistProjectSnapshot(nextProject, effectiveSavePath);
      if (result?.advancedTransitionsDetected) {
        const firstWarning = unresolvedTransitions[0]?.message;
        setImportNotice(
          "Certaines transitions du pack importé n'ont pas pu être modélisées complètement. "
          + "Story Studio a conservé la structure reconnue, mais vérifiez les retours concernés avant export."
          + (firstWarning ? ` Exemple : ${firstWarning}` : '')
        );
      }
    } catch (e) {
      showErrorDialog({
        title: 'Extraction du pack',
        message: `Erreur lors de l'extraction : ${e}`,
      });
    } finally {
      setUnpacking(null);
    }
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

  async function handleImportPodcastEpisodes(episodes, feed) {
    if (!Array.isArray(episodes) || episodes.length === 0) return;

    const selectedId = store.selectedId;
    const selectedNode = selectedId ? projectIndex.entryById.get(selectedId) : null;
    const targetMenuId = selectedNode?.type === 'menu'
      ? selectedNode.id
      : (selectedId ? (projectIndex.parentMenuById.get(selectedId) ?? null) : null);

    const total = episodes.length;
    const feedTitle = feed?.title || 'Podcast';
    const feedImage = feed?.imageUrl || null;
    logger.info(`import-podcast:start count=${total} target=${targetMenuId ?? 'root'}`);
    setImporting({ name: feedTitle, index: 0, total, phase: "Préparation de l'import..." });

    let failures = 0;
    try {
      for (let index = 0; index < episodes.length; index += 1) {
        const episode = episodes[index];
        const displayName = episode.title || `Épisode ${index + 1}`;
        try {
          setImporting({ name: displayName, index: index + 1, total, phase: "Téléchargement de l'épisode..." });
          const tmpAudio = await invoke('download_podcast_media', { url: episode.audioUrl, fileName: displayName });
          const audio = await copyGeneratedMediaToProject(tmpAudio);

          let itemImage = null;
          const imageUrl = episode.imageUrl || feedImage;
          if (imageUrl) {
            setImporting({ name: displayName, index: index + 1, total, phase: 'Récupération de la jaquette...' });
            try {
              const tmpImage = await invoke('download_podcast_media', { url: imageUrl, fileName: `${displayName}-jaquette` });
              itemImage = await copyGeneratedMediaToProject(tmpImage);
            } catch (imageError) {
              logger.warn(`import-podcast:cover-error name='${displayName}' error=${imageError}`);
            }
          }
          if (!itemImage) {
            itemImage = await extractAudioEmbeddedImage(audio);
          }

          const storyId = store.addStory(targetMenuId, audio);
          if (itemImage) store.updateItem(storyId, { itemImage });
        } catch (episodeError) {
          failures += 1;
          logger.error(`import-podcast:episode-error name='${displayName}' error=${episodeError}`);
        }
      }
    } finally {
      setImporting(null);
    }

    if (failures > 0) {
      showErrorDialog({
        title: 'Import du podcast',
        message: failures === total
          ? "Aucun épisode n'a pu être importé. Vérifiez votre connexion ou l'adresse du flux."
          : `${failures} épisode(s) sur ${total} n'ont pas pu être importés. Les autres ont bien été ajoutés.`,
        variant: failures === total ? 'warning' : 'info',
      });
    }
  }

  return {
    dispatchFiles,
    handleAddStory,
    handleAddStoryToMenu,
    handleImportFolder,
    handleUnpackZip,
    handleImportMediaLibrary,
    handleImportMediaLibraryFolder,
    handleImportPodcastEpisodes,
  };
}
