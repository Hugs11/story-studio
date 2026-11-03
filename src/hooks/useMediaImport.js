import { presentUserMessage } from '../i18n/userMessage.js';
import { translateImport as t, importPresentationError } from '../i18n/importPresentation.js';
import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sanitizeImportedName } from '../store/projectStore';
import { MEDIA_LANDING_TREE } from '../store/mediaToolSurface';
import { isFallbackProjectName } from '../store/projectSaveName.js';
import { basename } from '../utils/fileUtils';
import { logger } from '../utils/logger';
import { youtubeBlockedNoticeRef, youtubeImportFailureRef } from '../utils/youtubeErrors.js';
import { useImportSession } from './useImportSession';
import { useOsFileDrop } from './useOsFileDrop';

function isImportedPackPath(filePath) {
  return /\.(zip|7z)$/i.test(filePath || '');
}

function getImportDisplayName(filePath) {
  const fileName = basename(filePath);
  return sanitizeImportedName(fileName, fileName || t('import:media.current.label'));
}

// Textes des funnels média d'accueil (podcast/YouTube) : flux identiques,
// seul le vocabulaire change. Consommé par landMediaFunnel (et l'import éditeur
// YouTube pour les mêmes messages d'échec).
const MEDIA_FUNNEL_COPY = {
  podcast: {
    defaultTitle: 'Podcast',
    coverFilePrefix: 'podcast',
    logPrefix: 'podcast-funnel',
    allFailedRef: { key: 'import:podcast.import.failure' },
    someFailedNotice: (failures, total) => ({ key: 'import:podcast.batch.partial', params: { count: failures, total } }),
  },
  youtube: {
    defaultTitle: 'YouTube',
    coverFilePrefix: 'youtube',
    logPrefix: 'youtube-funnel',
    allFailedRef: { key: 'import:youtube.import.failure' },
    someFailedNotice: (failures, total) => ({ key: 'import:youtube.batch.partial', params: { count: failures, total } }),
  },
};

function partialFailureNotice(source, copy, result) {
  return (source === 'youtube' && youtubeBlockedNoticeRef(result))
    || copy.someFailedNotice(result.failures, result.total);
}

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
  mediaStorageRef,
  sessionModeRef,
  subscriptions,
  projectIndex,
  maybeCopyToProject,
  copyGeneratedMediaToProject,
  extractAudioEmbeddedImage,
  addPathsToMediaLibrary,
  persistProjectSnapshot,
  workspaceDirRef,
  importedPackPendingMetaRef,
  runFunnelLanding,
  onRevealImportedMedia,
  setImportNotice,
  setActiveDropZone,
  showErrorDialog,
}) {
  const [importing, setImporting] = useState(null);
  const [unpacking, setUnpacking] = useState(null);
  const liveStoreRef = useRef(store);
  liveStoreRef.current = store;

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
    mediaStorageRef,
    sessionModeRef,
    showErrorDialog,
    getImportDisplayName,
    isImportedPackPath,
    onImportedPackPromoted: () => { importedPackPendingMetaRef.current = true; },
  });

  const { dispatchFiles, handleImportMediaEpisodes } = importSession;

  // Funnels média d'accueil (podcast et YouTube) : flux jumeaux — crée la
  // session éphémère, pré-remplit titre + vignette depuis la source (flux RSS ou
  // liste yt-dlp), puis importe les épisodes/vidéos en histoires avant
  // l'atterrissage éditeur. Vocabulaire par source dans MEDIA_FUNNEL_COPY.
  async function landMediaFunnel(source, items, list, onProgress, subscriptionRequest) {
    const request = subscriptionRequest && subscriptions
      ? await subscriptions.prepareRequest(subscriptionRequest) : subscriptionRequest;
    const copy = MEDIA_FUNNEL_COPY[source];
    await runFunnelLanding('pack', async () => {
      const mediaRequest = importSession.captureImport();
      try {
        const listTitle = String(list?.title || '').trim();
        onProgress?.({ name: listTitle || copy.defaultTitle, index: 0, total: items.length, get phase() { return t('import:media.session.progress'); } });
        let listCover = null;
        if (items.length > 0 && list?.imageUrl) {
          try {
            const tmpImage = await invoke('download_podcast_media', {
              url: list.imageUrl,
              fileName: `${listTitle || copy.coverFilePrefix}-couverture`,
            });
            listCover = await copyGeneratedMediaToProject(tmpImage, mediaRequest.copies);
          } catch (coverError) {
            logger.warn(`${copy.logPrefix}:cover-error title='${listTitle || copy.defaultTitle}' error=${coverError}`);
          }
        }
        if (!mediaRequest.isCurrent()) return;
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
          // Le funnel d'accueil fabrique une session de pack : son point
          // d'arrivée est l'arbre, quel que soit l'éditeur ouvert avant lui.
          // Dit ici plutôt que déduit, pour ne dépendre d'aucun ordre entre
          // l'installation de la session et cet import.
          landing: MEDIA_LANDING_TREE,
          onProgress,
          suppressDialog: true,
        });
        if (!mediaRequest.isCurrent()) return;
        if (result.total > 0 && result.failures >= result.total) {
          throw importPresentationError(source === 'youtube'
            ? youtubeImportFailureRef(result, copy.allFailedRef)
            : copy.allFailedRef, {}, { code: 'IMPORT_MEDIA_BATCH_FAILED', cause: result.firstError, detail: result.firstError ? presentUserMessage(result.firstError).technicalDetail : '' });
        }
        if (result.failures > 0) {
          setImportNotice(partialFailureNotice(source, copy, result));
        }
        if (!mediaRequest.isCurrent()) return;
        subscriptions?.applyRequest?.(request, result.importedEpisodeIds);
        logger.info(`${copy.logPrefix}:landed count=${result.imported}`);
      } finally { mediaRequest.release(); }
    // eslint-disable-next-line i18next/no-literal-string -- Identifiant technique du journal.
    }, { errorLog: `${copy.logPrefix}:import-error` });
  }

  async function handlePodcastFunnelImport(episodes, feed, onProgress, request) {
    await landMediaFunnel('podcast', episodes, feed, onProgress, request);
  }

  // Dans l'éditeur, podcast et YouTube partagent la même arrivée : histoires
  // côté Libre, audio et jaquettes sélectionnés dans Médias côté graphe.
  async function importIntoEditor(source, items, list, onProgress = null, subscriptionRequest) {
    const projectEpoch = store.workEpochRef.current;
    const request = subscriptionRequest && subscriptions
      ? await subscriptions.prepareRequest(subscriptionRequest) : subscriptionRequest;
    if (projectEpoch !== store.workEpochRef.current) throw importPresentationError('import:media.follow.projectChanged', {}, { code: 'IMPORT_PROJECT_CHANGED' });
    const copy = MEDIA_FUNNEL_COPY[source];
    const result = await handleImportMediaEpisodes(items, list, {
      source,
      onProgress,
      suppressDialog: source === 'youtube',
    });
    const liveStore = liveStoreRef.current;
    const sourceTitle = String(list?.title ?? '').trim();
    if (result.imported > 0 && sourceTitle
      && projectEpoch === liveStore.workEpochRef.current
      && !liveStore.savePath && isFallbackProjectName(liveStore.project.projectName)) {
      // Le premier import réussi fournit un nom local de secours, dans les
      // deux éditeurs. Les titres d'auteur et les noms de fichiers choisis
      // restent indépendants ; un import tardif ne nomme pas un autre projet.
      liveStore.setProject((project) => isFallbackProjectName(project.projectName)
        ? { ...project, projectName: sourceTitle }
        : project);
    }
    if (result.importedPaths.length > 0 && projectEpoch === store.workEpochRef.current) {
      onRevealImportedMedia?.(result.importedPaths);
    }
    if (source === 'youtube' && result.total > 0 && result.failures >= result.total) {
      throw importPresentationError(youtubeImportFailureRef(result, copy.allFailedRef), {}, { code: 'IMPORT_MEDIA_BATCH_FAILED', cause: result.firstError, detail: result.firstError ? presentUserMessage(result.firstError).technicalDetail : '' });
    }
    if (source === 'youtube' && result.failures > 0) {
      setImportNotice(partialFailureNotice(source, copy, result));
    }
    if (projectEpoch === liveStore.workEpochRef.current) subscriptions?.applyRequest?.(request, result.importedEpisodeIds);
    logger.info(`${source}-editor:imported count=${result.imported}`);
    return result;
  }

  async function handlePodcastEditorImport(episodes, feed, onProgress, request) {
    return importIntoEditor('podcast', episodes, feed, onProgress, request);
  }

  async function handleYoutubeFunnelImport(videos, list, onProgress, request) {
    await landMediaFunnel('youtube', videos, list, onProgress, request);
  }

  // YouTube depuis l'éditeur réutilise le parcours podcast. Le funnel affiche
  // une erreur dédiée si toutes les vidéos échouent.
  async function handleYoutubeEditorImport(videos, list, onProgress, request) {
    return importIntoEditor('youtube', videos, list, onProgress, request);
  }

  useOsFileDrop({
    dispatchFiles,
    captureImport: importSession.captureImport,
    maybeCopyToProject,
    copyGeneratedMediaToProject,
    extractAudioEmbeddedImage,
    addPathsToMediaLibrary,
    setImporting,
    setActiveDropZone,
    getImportDisplayName,
    showErrorDialog,
  });

  return {
    ...importSession,
    importing,
    unpacking,
    handlePodcastFunnelImport,
    handlePodcastEditorImport,
    handleYoutubeFunnelImport,
    handleYoutubeEditorImport,
  };
}
