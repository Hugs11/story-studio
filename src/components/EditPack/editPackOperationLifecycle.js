/** Garde une seule opération Edit Pack active et invalide ses résultats au démontage. */
export function createEditPackOperationLifecycle() {
  let generation = 0;
  let running = false;
  let completionClaimed = false;

  function begin() {
    if (running) return null;
    running = true;
    completionClaimed = false;
    generation += 1;
    return generation;
  }

  function invalidate() {
    generation += 1;
    running = false;
    completionClaimed = false;
  }

  function isCurrent(token) {
    return running && token === generation;
  }

  function finish(token) {
    if (!isCurrent(token)) return false;
    running = false;
    return true;
  }

  function claimCompletion(token) {
    if (!isCurrent(token) || completionClaimed) return false;
    completionClaimed = true;
    return true;
  }

  function isRunning() {
    return running;
  }

  return { begin, claimCompletion, finish, invalidate, isCurrent, isRunning };
}

export async function runEditPackImportOperation({
  lifecycle,
  path,
  isFolder,
  convertFolder,
  classify,
  beforeLand = () => {},
  land,
}) {
  const token = lifecycle.begin();
  if (token === null) return { status: 'busy' };

  try {
    const zipPath = isFolder ? await convertFolder(path) : path;
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };

    const report = await classify(zipPath);
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    if (!report?.authoringEditable) {
      lifecycle.finish(token);
      return { status: 'classified', report, zipPath };
    }

    beforeLand();
    if (!lifecycle.claimCompletion(token)) return { status: 'cancelled' };
    await land(zipPath);
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    lifecycle.finish(token);
    return { status: 'landed', report, zipPath };
  } catch (error) {
    if (!lifecycle.isCurrent(token)) return { status: 'cancelled' };
    lifecycle.finish(token);
    return { status: 'error', error };
  }
}
