import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sanitizeImportedName } from '../store/projectStore';
import { basename } from '../utils/fileUtils';
import { formatFrenchCount } from '../utils/frenchText.js';
import { logger } from '../utils/logger';
import { useImportSession } from './useImportSession';
import { useOsFileDrop } from './useOsFileDrop';

function isImportedPackPath(filePath) {
  return /\.(zip|7z)$/i.test(filePath || '');
}

function getImportDisplayName(filePath) {
  const fileName = basename(filePath);
  return sanitizeImportedName(fileName, fileName || 'Import en cours');
}

// Textes des funnels média d'accueil (podcast/YouTube) : flux identiques,
// seul le vocabulaire change. Consommé par landMediaFunnel (et l'import éditeur
// YouTube pour les mêmes messages d'échec).
const MEDIA_FUNNEL_COPY = {
  podcast: {
    defaultTitle: 'Podcast',
    coverFilePrefix: 'podcast',
    logPrefix: 'podcast-funnel',
    allFailedMessage: "Aucun épisode n'a pu être importé. Vérifie ta connexion ou l'adresse du flux RSS.",
    someFailedNotice: (failures, total) => `${formatFrenchCount(failures, 'épisode', 'épisodes')} sur ${total} n'ont pas pu être importés. Les autres ont bien été ajoutés.`,
  },
  youtube: {
    defaultTitle: 'YouTube',
    coverFilePrefix: 'youtube',
    logPrefix: 'youtube-funnel',
    allFailedMessage: "Aucune vidéo n'a pu être importée. Vérifie ta connexion ou l'adresse YouTube.",
    someFailedNotice: (failures, total) => `${formatFrenchCount(failures, 'vidéo', 'vidéos')} sur ${total} n'ont pas pu être importées. Les autres ont bien été ajoutées.`,
  },
};

// Coordonne les funnels média d'accueil et les hooks d'import
// (useImportSession/useOsFileDrop), puis ré-expose leurs sorties pour
// ProjectActionsContext et useProjectLifecycle.
//
// Fournisseurs en amont : les gestionnaires de copie de useMediaTransferHandlers
// (maybeCopyToProject/copyGeneratedMediaToProject/extractAudioEmbeddedImage),
// persistProjectSnapshot (useSaveProgress) et runFunnelLanding (useWorkSession).
// Le hook doit donc être appelé APRÈS ces trois-là, et AVANT ses consommateurs
// (ProjectActionsContext, useProjectLifecycle qui lit unpackZipIntoBlankProject).
//
// HORS de ce hook (restent dans App.jsx) : le cycle de sauvegarde/promotion
// (useSaveProgress, useSessionMediaTriage) — ce n'est pas de l'import.
export function useMediaImport({
  store,
  projectIndex,
  maybeCopyToProject,
  copyGeneratedMediaToProject,
  extractAudioEmbeddedImage,
  addPathsToMediaLibrary,
  persistProjectSnapshot,
  workspaceDirRef,
  importedPackPendingMetaRef,
  runFunnelLanding,
  setImportNotice,
  setActiveDropZone,
  showErrorDialog,
  showConfirmDialog,
}) {
  const [importing, setImporting] = useState(null);
  const [unpacking, setUnpacking] = useState(null);

  const importSession = useImportSession({
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
    showConfirmDialog,
    getImportDisplayName,
    isImportedPackPath,
    onImportedPackPromoted: () => { importedPackPendingMetaRef.current = true; },
  });

  const { dispatchFiles, handleImportMediaEpisodes } = importSession;

  // Funnels média d'accueil (podcast et YouTube) : flux jumeaux — crée la
  // session éphémère, pré-remplit titre + vignette depuis la source (flux RSS ou
  // liste yt-dlp), puis importe les épisodes/vidéos en histoires avant
  // l'atterrissage éditeur. Vocabulaire par source dans MEDIA_FUNNEL_COPY.
  async function landMediaFunnel(source, items, list, onProgress) {
    const copy = MEDIA_FUNNEL_COPY[source];
    await runFunnelLanding('pack', async () => {
      const listTitle = String(list?.title || '').trim();
      onProgress?.({ name: listTitle || copy.defaultTitle, index: 0, total: items.length, phase: 'Préparation de la session…' });
      let listCover = null;
      if (list?.imageUrl) {
        try {
          const tmpImage = await invoke('download_podcast_media', {
            url: list.imageUrl,
            fileName: `${listTitle || copy.coverFilePrefix}-couverture`,
          });
          listCover = await copyGeneratedMediaToProject(tmpImage);
        } catch (coverError) {
          logger.warn(`${copy.logPrefix}:cover-error title='${listTitle || copy.defaultTitle}' error=${coverError}`);
        }
      }
      if (listTitle || listCover) {
        store.setProject((project) => ({
          ...project,
          ...(listTitle ? { projectName: listTitle, rootName: listTitle } : {}),
          ...(listCover ? { rootImage: listCover, thumbnailImage: listCover } : {}),
          packMetadata: {
            ...(project.packMetadata ?? {}),
            ...(listTitle ? { title: listTitle } : {}),
          },
        }));
      }
      store.setSelectedId('root');
      const result = await handleImportMediaEpisodes(items, list, {
        source,
        targetMenuId: null,
        onProgress,
        suppressDialog: true,
      });
      if (result.total > 0 && result.failures >= result.total) {
        throw new Error(copy.allFailedMessage);
      }
      if (result.failures > 0) {
        setImportNotice(copy.someFailedNotice(result.failures, result.total));
      }
      logger.info(`${copy.logPrefix}:landed count=${result.imported}`);
    }, { errorLog: `${copy.logPrefix}:import-error` });
  }

  async function handlePodcastFunnelImport(episodes, feed, onProgress) {
    await landMediaFunnel('podcast', episodes, feed, onProgress);
  }

  async function handleYoutubeFunnelImport(videos, list, onProgress) {
    await landMediaFunnel('youtube', videos, list, onProgress);
  }

  // Import YouTube depuis l'éditeur libre : pas de nouvelle session, on
  // insère dans le projet courant (cible déduite de la sélection comme les autres
  // imports média). Lève en cas d'échec total → écran d'erreur du funnel.
  async function handleYoutubeEditorImport(videos, list, onProgress) {
    const copy = MEDIA_FUNNEL_COPY.youtube;
    const result = await handleImportMediaEpisodes(videos, list, {
      source: 'youtube',
      onProgress,
      suppressDialog: true,
    });
    if (result.total > 0 && result.failures >= result.total) {
      throw new Error(copy.allFailedMessage);
    }
    if (result.failures > 0) {
      setImportNotice(copy.someFailedNotice(result.failures, result.total));
    }
    logger.info(`youtube-editor:imported count=${result.imported}`);
  }

  useOsFileDrop({
    dispatchFiles,
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    extractAudioEmbeddedImage,
    addPathsToMediaLibrary,
    setImporting,
    setActiveDropZone,
    getImportDisplayName,
  });

  return {
    ...importSession,
    importing,
    unpacking,
    handlePodcastFunnelImport,
    handleYoutubeFunnelImport,
    handleYoutubeEditorImport,
  };
}
