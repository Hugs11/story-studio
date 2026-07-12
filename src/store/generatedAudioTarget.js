// Dispatch pur de l'audio genere vers sa cible. Seul le message de fin global
// doit passer par la mutation de propagation, afin de garder ses projections
// liees synchronisees.
export function applyGeneratedAudioToTarget({
  target,
  path,
  job = null,
  store,
  projectIndex,
  getStoryName = () => '',
}) {
  if (!target || !path) return;
  switch (target.kind) {
    case 'root':
      if (target.field === 'nightModeAudio') store.updateGlobalEndMessage({ nightModeAudio: path });
      else store.updateRootMedia(target.field, path);
      return;
    case 'rootStory':
      store.updateStoryAudio(path);
      return;
    case 'newStory':
      store.addStory(target.menuId ?? null, path, { name: getStoryName(job?.request?.text) });
      return;
    case 'menu':
      store.updateMenu(target.entryId, { [target.field]: path });
      return;
    case 'story':
      store.updateItem(target.entryId, { [target.field]: path });
      return;
    case 'storySequence': {
      const entry = projectIndex.entryById.get(target.entryId);
      if (!entry?.afterPlaybackSequence?.length) return;
      store.updateItem(target.entryId, {
        afterPlaybackSequence: entry.afterPlaybackSequence.map((step) => (
          step.id === target.stepId ? { ...step, [target.field]: path } : step
        )),
      });
      return;
    }
    case 'storyHomeStep': {
      const entry = projectIndex.entryById.get(target.entryId);
      if (!entry?.afterPlaybackHomeStep) return;
      store.updateItem(target.entryId, {
        afterPlaybackHomeStep: { ...entry.afterPlaybackHomeStep, [target.field]: path },
      });
      return;
    }
    default:
      return;
  }
}
