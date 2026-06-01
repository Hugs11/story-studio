import { useCallback } from 'react';
import { pathKey } from '../utils/fileUtils';

const AUDIO_FIELD_LABELS = {
  rootAudio: 'audio d’accueil',
  nightModeAudio: 'audio de fin',
  itemAudio: 'audio de sélection',
  audio: 'audio de lecture',
  afterPlaybackPromptAudio: 'audio après lecture',
  afterPlaybackSequence: 'audio de fin intermédiaire',
  afterPlaybackHomeStep: 'audio Home pendant lecture',
  coverAudio: 'audio de couverture',
};

function audioFieldLabel(field) {
  return AUDIO_FIELD_LABELS[field] || 'champ audio';
}

export function useAiJobUsage({ project, projectIndex }) {
  const getAudioJobUsage = useCallback((job) => {
    if (!job || job.kind !== 'audio' || job.status !== 'done' || !job.resultPath) return null;
    const resultPath = pathKey(job.resultPath);
    const usages = [];

    function addUsage(path, nodeName, field) {
      if (path && pathKey(path) === resultPath) {
        usages.push(`Nœud : ${nodeName} · Champ : ${audioFieldLabel(field)}`);
      }
    }

    addUsage(project?.rootAudio, project?.name || 'Accueil', 'rootAudio');
    addUsage(project?.nightModeAudio, 'Fin', 'nightModeAudio');

    for (const flatEntry of projectIndex.flatEntries ?? []) {
      const entry = flatEntry.entry ?? flatEntry;
      const nodeName = entry.name || (entry.type === 'menu' ? 'Menu sans titre' : entry.type === 'zip' ? 'ZIP sans titre' : 'Histoire sans titre');
      if (entry.type === 'menu') {
        addUsage(entry.audio, nodeName, 'audio');
      } else if (entry.type === 'story') {
        addUsage(entry.itemAudio, nodeName, 'itemAudio');
        addUsage(entry.audio, nodeName, 'audio');
        addUsage(entry.afterPlaybackPromptAudio, nodeName, 'afterPlaybackPromptAudio');
        for (const step of entry.afterPlaybackSequence ?? []) {
          addUsage(step.audio, nodeName, 'afterPlaybackSequence');
        }
        addUsage(entry.afterPlaybackHomeStep?.audio, nodeName, 'afterPlaybackHomeStep');
      } else if (entry.type === 'zip') {
        addUsage(entry.coverAudio, nodeName, 'coverAudio');
      }
    }

    if (usages.length > 0) {
      return {
        state: 'used',
        label: usages.length === 1 ? 'Utilisé' : `Utilisé ×${usages.length}`,
        detail: usages.join(' ; '),
      };
    }

    const target = job.target;
    let currentPath = null;
    let targetExists = true;
    let nodeName = null;
    let fieldLabel = audioFieldLabel(target?.field);

    switch (target?.kind) {
      case 'root':
        currentPath = project?.[target.field] ?? null;
        nodeName = project?.name || 'Accueil';
        break;
      case 'rootStory':
        currentPath = project?.rootEntries?.[0]?.[target.field] ?? null;
        nodeName = project?.rootEntries?.[0]?.name || 'Histoire principale';
        break;
      case 'menu': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry;
        currentPath = entry?.[target.field] ?? null;
        nodeName = entry?.name || 'Menu sans titre';
        break;
      }
      case 'story': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry;
        currentPath = entry?.[target.field] ?? null;
        nodeName = entry?.name || 'Histoire sans titre';
        break;
      }
      case 'storySequence': {
        const entry = projectIndex.entryById.get(target.entryId);
        const step = entry?.afterPlaybackSequence?.find((item) => item.id === target.stepId);
        targetExists = !!entry && !!step;
        currentPath = step?.[target.field] ?? null;
        nodeName = `${entry?.name || 'Histoire sans titre'} · ${step?.name || 'Sequence de fin'}`;
        fieldLabel = audioFieldLabel('afterPlaybackSequence');
        break;
      }
      case 'storyHomeStep': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry && !!entry.afterPlaybackHomeStep;
        currentPath = entry?.afterPlaybackHomeStep?.[target.field] ?? null;
        nodeName = `${entry?.name || 'Histoire sans titre'} · Home pendant lecture`;
        fieldLabel = audioFieldLabel('afterPlaybackHomeStep');
        break;
      }
      default:
        targetExists = false;
        break;
    }

    if (!targetExists) {
      return { state: 'unused', label: 'Non utilisé', detail: `${fieldLabel} n’existe plus` };
    }
    if (pathKey(currentPath) === resultPath) {
      return { state: 'used', label: 'Utilisé', detail: `Nœud : ${nodeName} · Champ : ${fieldLabel}` };
    }
    return { state: 'unused', label: 'Non utilisé', detail: `Nœud : ${nodeName} · Champ modifié : ${fieldLabel}` };
  }, [project, projectIndex]);

  const getImageJobUsage = useCallback((job) => {
    if (!job || job.kind === 'audio' || job.status !== 'done' || !job.resultPaths?.length) return null;
    const resultSet = new Set(job.resultPaths.map(pathKey));
    const usages = [];

    function addUsage(path, nodeName, fieldLabel) {
      if (path && resultSet.has(pathKey(path))) {
        usages.push(`${nodeName} · ${fieldLabel}`);
      }
    }

    const rootLabel = project?.projectName || project?.packMetadata?.title || 'Accueil';
    addUsage(project?.rootImage, rootLabel, 'image d’accueil');
    addUsage(project?.thumbnailImage, rootLabel, 'vignette');

    for (const flatEntry of projectIndex.flatEntries ?? []) {
      const entry = flatEntry.entry ?? flatEntry;
      const nodeName = entry.name || (entry.type === 'menu' ? 'Menu sans titre' : 'Histoire sans titre');
      addUsage(entry.image, nodeName, entry.type === 'menu' ? 'image du menu' : 'image de l’histoire');
      addUsage(entry.itemImage, nodeName, 'image de sélection');
      addUsage(entry.coverImage, nodeName, 'couverture');
    }

    if (usages.length > 0) {
      return {
        state: 'used',
        label: usages.length === 1 ? 'Utilisée' : `Utilisées ×${usages.length}`,
        detail: usages.join(' ; '),
      };
    }
    return { state: 'unused', label: 'Non utilisée', detail: 'Aucune image de cette génération n’est assignée au projet.' };
  }, [project, projectIndex]);

  return { getAudioJobUsage, getImageJobUsage };
}
