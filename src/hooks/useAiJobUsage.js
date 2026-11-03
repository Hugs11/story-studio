import { useTranslation } from 'react-i18next';
import { translateAi as t } from '../i18n/aiPresentation.js';
import { useCallback } from 'react';
import { pathKey } from '../utils/fileUtils';
import { advancedMediaUsageForPaths } from '../store/advancedAuthoring/mediaUsage';
import { isAdvancedProject } from '../store/projectWorkState';

const samePath = (a, b) => pathKey(a) === pathKey(b);

// La réponse d'un projet graphe, pour l'audio comme pour l'image. Trois issues,
// et la troisième est la raison d'être de cette branche : sans elle, un projet
// graphe recevait « Non utilisé » — une affirmation — là où l'arbre parcouru
// était simplement vide. Un auteur supprime un fichier sur cette phrase.
function advancedJobUsage(project, advancedUsages, paths, words) {
  const found = advancedMediaUsageForPaths(project, advancedUsages, paths, samePath);
  if (!found) return { state: 'unused', label: words.unused, detail: words.noBinding };
  if (!found.bound) return { state: 'unused', label: words.unused, detail: words.noBinding };
  if (!found.known) {
    return {
      state: 'unknown',
      label: t("ai:usage.state.unknown"),
      detail: t("ai:usage.state.unknownHelp"),
    };
  }
  if (found.usages.length === 0) {
    return { state: 'unused', label: words.unused, detail: words.boundUnreferenced };
  }
  const detail = found.usages
    .map((usage) => t("ai:usage.screen.detail", { name: usage.label, field: usage.field === "image" ? t("ai:queue.kind.image").toLowerCase() : t("ai:queue.kind.audio").toLowerCase() }))
    .join(' ; ');
  return {
    state: 'used',
    label: found.usages.length === 1 ? words.used : t(words.usedKey, { count: found.usages.length }),
    detail,
  };
}

const AUDIO_FIELD_LABELS = {
  rootAudio: "ai:usage.audio.root",
  nightModeAudio: "ai:usage.audio.end",
  itemAudio: "ai:usage.audio.selection",
  audio: "ai:usage.audio.playback",
  afterPlaybackPromptAudio: "ai:usage.audio.after",
  afterPlaybackSequence: "ai:usage.audio.sequence",
  afterPlaybackHomeStep: "ai:usage.audio.home",
  coverAudio: "ai:usage.audio.cover",
};

function audioFieldLabel(field) {
  return AUDIO_FIELD_LABELS[field] ? t(AUDIO_FIELD_LABELS[field]) : t("ai:usage.audio.field");
}

export function useAiJobUsage({ project, projectIndex, advancedMediaUsages = null }) {
  useTranslation();
  const getAudioJobUsage = useCallback((job) => {
    if (!job || job.kind !== 'audio' || job.status !== 'done' || !job.resultPath) return null;
    if (isAdvancedProject(project)) {
      return advancedJobUsage(project, advancedMediaUsages, [job.resultPath], {
        used: t("ai:usage.audio.used"), usedKey: "ai:usage.audio.count",
        unused: t("ai:usage.audio.unused"),
        noBinding: t("ai:usage.audio.unbound"),
        boundUnreferenced: t("ai:usage.file.unreferenced"),
      });
    }
    const resultPath = pathKey(job.resultPath);
    const usages = [];

    function addUsage(path, nodeName, field) {
      if (path && pathKey(path) === resultPath) {
        usages.push(t("ai:usage.node.detail", { name: nodeName, field: audioFieldLabel(field) }));
      }
    }

    addUsage(project?.rootAudio, project?.name || t("ai:usage.node.home"), 'rootAudio');
    addUsage(project?.nightModeAudio, t("ai:usage.node.end"), 'nightModeAudio');

    for (const flatEntry of projectIndex.flatEntries ?? []) {
      const entry = flatEntry.entry ?? flatEntry;
      const nodeName = entry.name || (entry.type === 'menu' ? t("ai:usage.node.menu") : entry.type === 'zip' ? t("ai:usage.node.zip") : t("ai:usage.node.story"));
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
        label: usages.length === 1 ? t("ai:usage.audio.used") : t("ai:usage.audio.count", { count: usages.length }),
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
        nodeName = project?.name || t("ai:usage.node.home");
        break;
      case 'rootStory':
        currentPath = project?.rootEntries?.[0]?.[target.field] ?? null;
        nodeName = project?.rootEntries?.[0]?.name || t("ai:usage.node.mainStory");
        break;
      case 'menu': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry;
        currentPath = entry?.[target.field] ?? null;
        nodeName = entry?.name || t("ai:usage.node.menu");
        break;
      }
      case 'story': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry;
        currentPath = entry?.[target.field] ?? null;
        nodeName = entry?.name || t("ai:usage.node.story");
        break;
      }
      case 'storySequence': {
        const entry = projectIndex.entryById.get(target.entryId);
        const step = entry?.afterPlaybackSequence?.find((item) => item.id === target.stepId);
        targetExists = !!entry && !!step;
        currentPath = step?.[target.field] ?? null;
        nodeName = `${entry?.name || t("ai:usage.node.story")} · ${step?.name || t("ai:usage.node.sequence")}`;
        fieldLabel = audioFieldLabel('afterPlaybackSequence');
        break;
      }
      case 'storyHomeStep': {
        const entry = projectIndex.entryById.get(target.entryId);
        targetExists = !!entry && !!entry.afterPlaybackHomeStep;
        currentPath = entry?.afterPlaybackHomeStep?.[target.field] ?? null;
        nodeName = t("ai:usage.node.homeStep", { name: entry?.name || t("ai:usage.node.story") });
        fieldLabel = audioFieldLabel('afterPlaybackHomeStep');
        break;
      }
      default:
        targetExists = false;
        break;
    }

    if (!targetExists) {
      return { state: 'unused', label: t("ai:usage.audio.unused"), detail: t("ai:usage.field.missing", { field: fieldLabel }) };
    }
    if (pathKey(currentPath) === resultPath) {
      return { state: 'used', label: t("ai:usage.audio.used"), detail: t("ai:usage.node.detail", { name: nodeName, field: fieldLabel }) };
    }
    return { state: 'unused', label: t("ai:usage.audio.unused"), detail: t("ai:usage.node.modified", { name: nodeName, field: fieldLabel }) };
  }, [project, projectIndex, advancedMediaUsages]);

  const getImageJobUsage = useCallback((job) => {
    if (!job || job.kind === 'audio' || job.status !== 'done' || !job.resultPaths?.length) return null;
    if (isAdvancedProject(project)) {
      return advancedJobUsage(project, advancedMediaUsages, job.resultPaths, {
        used: t("ai:usage.image.used"), usedKey: "ai:usage.graphImage.count",
        unused: t("ai:usage.image.unused"),
        noBinding: t("ai:usage.image.unbound"),
        boundUnreferenced: t("ai:usage.file.unreferenced"),
      });
    }
    const resultSet = new Set(job.resultPaths.map(pathKey));
    const usages = [];

    function addUsage(path, nodeName, fieldLabel) {
      if (path && resultSet.has(pathKey(path))) {
        usages.push(`${nodeName} · ${fieldLabel}`);
      }
    }

    const rootLabel = project?.projectName || project?.packMetadata?.title || t("ai:usage.node.home");
    addUsage(project?.rootImage, rootLabel, t("ai:usage.image.start"));
    addUsage(project?.thumbnailImage, rootLabel, t("ai:usage.image.thumbnail"));

    for (const flatEntry of projectIndex.flatEntries ?? []) {
      const entry = flatEntry.entry ?? flatEntry;
      const nodeName = entry.name || (entry.type === 'menu' ? t("ai:usage.node.menu") : t("ai:usage.node.story"));
      addUsage(entry.image, nodeName, entry.type === 'menu' ? t("ai:usage.image.menu") : t("ai:usage.image.story"));
      addUsage(entry.itemImage, nodeName, t("ai:usage.image.selection"));
      addUsage(entry.coverImage, nodeName, t("ai:usage.image.cover"));
    }

    if (usages.length > 0) {
      return {
        state: 'used',
        label: usages.length === 1 ? t("ai:usage.image.used") : t("ai:usage.image.count", { count: usages.length }),
        detail: usages.join(' ; '),
      };
    }
    return { state: 'unused', label: t("ai:usage.image.unused"), detail: t("ai:usage.image.unassigned") };
  }, [project, projectIndex, advancedMediaUsages]);

  return { getAudioJobUsage, getImageJobUsage };
}
