/** Garde une seule opération Edit Pack active et invalide ses résultats au démontage. */
export function createEditPackOperationLifecycle() {
  let generation = 0;
  let running = false;
  let completionClaimed = false;
  let active = true;
  let session = 0;

  function begin() {
    if (!active || running) return null;
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

  function activate() {
    if (active) return;
    active = true;
    session += 1;
  }

  function deactivate() {
    active = false;
    session += 1;
    invalidate();
  }

  function captureSession() {
    return active ? session : null;
  }

  function isSessionCurrent(token) {
    return active && token !== null && token === session;
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

  function isActive() {
    return active;
  }

  return {
    activate,
    begin,
    captureSession,
    claimCompletion,
    deactivate,
    finish,
    invalidate,
    isActive,
    isCurrent,
    isRunning,
    isSessionCurrent,
  };
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
  if (!lifecycle.isActive()) return { status: 'cancelled' };
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
