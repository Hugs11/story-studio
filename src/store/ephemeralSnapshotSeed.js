function createSessionToken() {
  return {};
}

export function createEphemeralSnapshotSeedState({
  seeded = false,
  savedSnapshot = null,
} = {}) {
  return {
    sessionToken: createSessionToken(),
    inFlight: null,
    seeded,
    savedSnapshot,
    // File unique des écritures du fichier de reprise : instantané immédiat et
    // tick périodique écrivent le même fichier, dans l'ordre où ils partent.
    // Survit aux transitions : une promotion attend aussi l'écriture en vol
    // d'une session qui se termine.
    writeChain: Promise.resolve(),
  };
}

export function enqueueEphemeralSnapshotWrite(state, task) {
  state.writeChain = state.writeChain.catch(() => {}).then(task);
  return state.writeChain;
}

export function resetEphemeralSnapshotSeedState(state, {
  seeded = false,
  savedSnapshot = null,
} = {}) {
  state.sessionToken = createSessionToken();
  state.inFlight = null;
  state.seeded = seeded;
  state.savedSnapshot = savedSnapshot;
}

export function beginEphemeralSnapshotSeed(state, {
  sessionMode,
  path,
  snapshot,
} = {}) {
  if (sessionMode !== 'ephemeral' || !path || state.inFlight || state.savedSnapshot === snapshot) return null;
  const write = {
    token: {},
    sessionToken: state.sessionToken,
    path,
    snapshot,
  };
  state.inFlight = write;
  return write;
}

export function acceptEphemeralSnapshotSeed(state, write, {
  sessionMode,
  path,
} = {}) {
  const isCurrent = !!write
    && state.inFlight?.token === write.token
    && state.sessionToken === write.sessionToken
    && sessionMode === 'ephemeral'
    && path === write.path;
  if (!isCurrent) return false;
  state.seeded = true;
  state.savedSnapshot = write.snapshot;
  return true;
}

export function finishEphemeralSnapshotSeed(state, write) {
  if (write && state.inFlight?.token === write.token) {
    state.inFlight = null;
  }
}
