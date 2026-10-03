import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { sanitizeImportedName } from '../store/projectStore';
import { MEDIA_LANDING_TREE } from '../store/mediaToolSurface';
import { isFallbackProjectName } from '../store/projectSaveName.js';
import { basename } from '../utils/fileUtils';
import { formatFrenchCount } from '../utils/frenchText.js';
import { logger } from '../utils/logger';
import { youtubeBlockedNotice, youtubeImportFailure } from '../utils/youtubeErrors.js';
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
    allFailedMessage: "Aucune vidéo n'a pu être importée.",
    someFailedNotice: (failures, total) => `${formatFrenchCount(failures, 'vidéo', 'vidéos')} sur ${total} n'ont pas pu être importées. Les autres ont bien été ajoutées.`,
  },
};

function partialFailureNotice(source, copy, result) {
  return (source === 'youtube' && youtubeBlockedNotice(result))
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
        // Le funnel d'accueil fabrique une session de pack : son point
        // d'arrivée est l'arbre, quel que soit l'éditeur ouvert avant lui.
        // Dit ici plutôt que déduit, pour ne dépendre d'aucun ordre entre
        // l'installation de la session et cet import.
        landing: MEDIA_LANDING_TREE,
        onProgress,
        suppressDialog: true,
      });
      if (result.total > 0 && result.failures >= result.total) {
        throw new Error(source === 'youtube'
          ? youtubeImportFailure(result, copy.allFailedMessage)
          : copy.allFailedMessage);
      }
      if (result.failures > 0) {
        setImportNotice(partialFailureNotice(source, copy, result));
      }
      logger.info(`${copy.logPrefix}:landed count=${result.imported}`);
    }, { errorLog: `${copy.logPrefix}:import-error` });
  }

  async function handlePodcastFunnelImport(episodes, feed, onProgress) {
    await landMediaFunnel('podcast', episodes, feed, onProgress);
  }

  // Dans l'éditeur, podcast et YouTube partagent la même arrivée : histoires
  // côté Libre, audio et jaquettes sélectionnés dans Médias côté graphe.
  async function importIntoEditor(source, items, list, onProgress = null) {
    const copy = MEDIA_FUNNEL_COPY[source];
    const projectEpoch = store.workEpochRef.current;
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
      throw new Error(youtubeImportFailure(result, copy.allFailedMessage));
    }
    if (source === 'youtube' && result.failures > 0) {
      setImportNotice(partialFailureNotice(source, copy, result));
    }
    logger.info(`${source}-editor:imported count=${result.imported}`);
    return result;
  }

  async function handlePodcastEditorImport(episodes, feed) {
    return importIntoEditor('podcast', episodes, feed);
  }

  async function handleYoutubeFunnelImport(videos, list, onProgress) {
    await landMediaFunnel('youtube', videos, list, onProgress);
  }

  // YouTube depuis l'éditeur réutilise le parcours podcast. Le funnel affiche
  // une erreur dédiée si toutes les vidéos échouent.
  async function handleYoutubeEditorImport(videos, list, onProgress) {
    return importIntoEditor('youtube', videos, list, onProgress);
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
    handlePodcastEditorImport,
    handleYoutubeFunnelImport,
    handleYoutubeEditorImport,
  };
}
