/**
 * Orchestre une ressource média asynchrone dont seule la requête la plus récente
 * peut devenir visible ou audible. Le propriétaire fournit le nettoyage de la
 * ressource courante et celui d'une ressource créée trop tard.
 */
export function createMediaRequestLifecycle({
  clearCurrent,
  load,
  createResource = (value) => value,
  applyResource,
  discardResource = () => {},
  onError = () => {},
}) {
  let generation = 0;

  function invalidate({ clear = true } = {}) {
    generation += 1;
    if (clear) clearCurrent();
  }

  async function request(input) {
    const token = ++generation;
    clearCurrent();
    if (!input) return 'empty';

    try {
      const loaded = await load(input);
      if (token !== generation) return 'obsolete';

      const resource = await createResource(loaded, input);
      if (token !== generation) {
        discardResource(resource, input);
        return 'obsolete';
      }

      applyResource(resource, input);
      return 'applied';
    } catch (error) {
      if (token !== generation) return 'obsolete';
      onError(error, input);
      return 'error';
    }
  }

  return { invalidate, request };
}

/**
 * Clé stable d'une requête média dans son contexte logique. Deux écrans distincts
 * qui réutilisent le même fichier doivent tout de même relancer la lecture.
 */
export function createMediaRequestKey(request, context = []) {
  return JSON.stringify([
    ...context,
    request?.kind ?? null,
    request?.path ?? null,
    request?.zipPath ?? null,
    request?.assetHash ?? null,
  ]);
}
