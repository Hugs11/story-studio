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
import { replaceEntryWithEntries } from '../store/projectModel';
import { KEYS, read as readSetting } from '../store/persistentSettings';
import { markEntryAudioSkipSilence } from '../store/projectHelpers';
import { pickFolder, pickMultipleAudioOrZip, pickMultipleMediaFiles } from './useFileDialog';
import { importFilesToMediaLibrary } from './mediaLibraryImport';
import { basename } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { parseConventionName } from '../utils/packConvention';

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
    if (!effectiveSavePath) {
      const path = await handleSaveProject();
      if (!path) return;
      effectiveSavePath = path;
    }

    const skipSilenceForExtractedAudio = await ask(
      "Les audios d'un pack extrait contiennent souvent déjà leurs silences de début/fin. Voulez-vous exclure les audios extraits de l'ajout de silence global ?",
      {
        title: 'Extraction du pack',
        kind: 'info',
        okLabel: 'Exclure du silence',
        cancelLabel: 'Garder le traitement global',
      }
    );

    setUnpacking({ name: zipItem.name || 'ZIP en cours' });
    try {
      const extractedDirName = sanitizeImportedName(zipItem.name || itemId, itemId).replace(/[/\\:*?"<>|]/g, '_');
      const wsDir = workspaceDirRef.current || readSetting(KEYS.WORKSPACE_DIR, { defaultValue: '' }) || effectiveSavePath.replace(/[\\/][^\\/]+$/, '');
      const destDir = `${getExtractedZipsDir(wsDir)}/${extractedDirName}`;
      const result = await invoke('unpack_zip_to_entries', {
        zipPath: zipItem.zipPath,
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
      const zipFilename = basename(zipItem.zipPath || '').replace(/\.(zip|7z)$/i, '');
      const rawTitle = String(result?.title || '').trim();
      const parsedZipFilename = parseConventionName(zipFilename);
      const parsedPackName = parseConventionName(rawTitle) ?? parsedZipFilename;
      const isZipConvention = /^\d+\+\]/.test(zipFilename);
      const isTitleConvention = /^\d+\+\]/.test(rawTitle);
      const packName = (rawTitle && (isTitleConvention || !isZipConvention))
        ? sanitizeImportedName(rawTitle, zipItem.name || 'Pack importé')
        : sanitizeImportedName(zipFilename || zipItem.name, 'Pack importé');
      const packMetadata = parsedPackName
        ? {
            ...parsedPackName,
            version: result?.packVersion ?? parsedPackName.version,
            description: result?.packDescription ?? '',
            namingMode: 'convention',
          }
        : {
            title: packName,
            author: '',
            version: result?.packVersion ?? 1,
            minAge: ((zipFilename || zipItem.name || '').match(/^(\d+)\+\]/)?.[1]) || '3',
            producer: '',
            bonus: '',
            description: result?.packDescription ?? '',
            namingMode: 'convention',
            legacyExportName: '',
            legacyName: '',
          };
      const isBlankProject = menuId == null
        && (store.project.rootEntries ?? []).length <= 1
        && !store.project.projectName?.trim()
        && !store.project.packMetadata?.title
        && !store.project.rootAudio
        && !store.project.rootImage;
      let nextProject = isBlankProject
        ? {
            ...store.project,
            projectType: 'pack',
            projectName: parsedZipFilename ? '' : sanitizeImportedName(zipFilename || packName, 'Pack importe'),
            packMetadata,
            rootAudio: result?.rootAudio ?? null,
            rootImage: result?.rootImage ?? null,
            thumbnailImage: result?.thumbnailImage ?? result?.rootImage ?? null,
            sameImage: !!(result?.rootImage) && !result?.thumbnailImage,
            nativeGraph: result?.nativeGraph ?? null,
            rootEntries: processedEntries,
          }
        : replaceEntryWithEntries(store.project, menuId, itemId, processedEntries);
      const unresolvedTransitions = Array.isArray(result?.unresolvedTransitions)
        ? result.unresolvedTransitions.map((warning) => ({
            ...warning,
            sourceRootId: result?.rootId ?? null,
            sourceName: packName,
          }))
        : [];
      nextProject = {
        ...nextProject,
        importWarnings: [
          ...(nextProject.importWarnings ?? []).filter((warning) => warning?.sourceRootId !== result?.rootId),
          ...unresolvedTransitions,
        ],
      };
      if (result?.nightMode && result?.nightModeAudio && !nextProject.globalOptions?.nightMode) {
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

  return {
    dispatchFiles,
    handleAddStory,
    handleAddStoryToMenu,
    handleImportFolder,
    handleUnpackZip,
    handleImportMediaLibrary,
    handleImportMediaLibraryFolder,
  };
}
