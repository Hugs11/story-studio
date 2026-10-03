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
  // Garde d'époque commune à toutes les cibles : une voix demandée pour un
  // travail et arrivée après l'ouverture d'un autre ne modifie pas ce dernier.
  // Le fichier produit reste le résultat du job, dans la file et la médiathèque.
  if (target.projectEpoch !== undefined && target.projectEpoch !== store.workEpochRef?.current) return;
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
    case 'mediaLibrary':
      // Cote graphe. Le depot en bibliotheque est deja fait par la file
      // elle-meme : tout audio genere y entre par `onMediaCreated`. Ce cas
      // existe pour dire que **rien d'autre** n'est ecrit — aucun Ecran n'est
      // cree par le seul fait qu'une voix a ete produite. Une cible absente
      // aurait le meme effet, et n'aurait pas la meme intention.
      return;
    case 'advancedStage':
      // La cible avancée conserve le geste du panneau qui l'a créée. La garde
      // d'époque empêche une génération terminée après un changement de
      // projet d'agir sur un autre document portant le même identifiant ;
      // sans époque, la cible ne peut pas prouver qu'elle vise ce document.
      if (target.projectEpoch !== store.workEpochRef?.current) return;
      return target.apply?.(path);
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
