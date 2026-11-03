import { getExportPackName } from '../../utils/packConvention.js';
import { buildAggregateProject, defaultMetadataForPacks } from './aggregateProject.js';

// User fields remain authoritative after the metadata form has been applied.
export function refreshAggregateMetadata(current, packs, edited) {
  if (edited) return current;
  return { ...current, minAge: defaultMetadataForPacks(packs, current.uuid).minAge };
}

export function moveAggregatePack(packs, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= packs.length || target < 0 || target >= packs.length) return packs;
  const next = [...packs];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

// All dependencies are copied before the project can become visible. A failed
// copy leaves the assistant's source assets intact for another attempt.
export async function prepareAggregateLanding({ draft, preparation, workspaceDir, transfer, copy, requestId }) {
  const replacements = new Map();
  if (preparation) {
    const receipt = await transfer({ preparationId: preparation.preparationId, workSessionId: workspaceDir, requestId });
    if (receipt.transferred !== true || receipt.ownerSessionId !== workspaceDir || receipt.preparationId !== preparation.preparationId || !Array.isArray(receipt.assets)) {
      throw { code: 'CATALOG_ASSEMBLY_TRANSFER_FAILED', params: {} };
    }
    for (const asset of receipt.assets) replacements.set(asset.sourcePath, asset.sessionPath);
    // A successful receipt must cover every original preparation reference.
    for (const entry of preparation.entries) {
      if (!replacements.has(entry.zipPath) || (entry.coverPath && !replacements.has(entry.coverPath))) {
        throw { code: 'CATALOG_ASSEMBLY_TRANSFER_FAILED', params: {} };
      }
    }
  }
  async function promote(path) {
    if (!path) return path;
    if (replacements.has(path)) return replacements.get(path);
    const result = await copy(path, workspaceDir);
    replacements.set(path, result);
    return result;
  }
  const packs = [];
  for (const pack of draft.packs) {
    packs.push({ ...pack, path: await promote(pack.path), coverImage: await promote(pack.coverImage), coverAudio: await promote(pack.coverAudio) });
  }
  return buildAggregateProject({
    packs,
    rootAudio: await promote(draft.rootAudio),
    rootImage: await promote(draft.rootImage),
    metadata: draft.metadata,
  });
}

// Guards run before a new work session is created. Neither destination selection
// nor a cancelled guard installs a project or starts a native task.
export async function landAggregate({ confirmBackgroundWork, confirmSave, runLanding, prepare, install }) {
  if (!await confirmBackgroundWork() || !await confirmSave()) return false;
  await runLanding('pack', async (workspaceDir, session) => {
    const project = await prepare(workspaceDir);
    if (session?.isCurrent && !session.isCurrent()) throw { code: 'CATALOG_ASSEMBLY_SESSION_INVALID', params: {} };
    await install(project);
  }, { applyProjectType: false, forceEphemeral: true, errorLog: 'aggregate:land-error' });
  return true;
}

export const INITIAL_AGGREGATE_DESTINATION = { destination: 'editor', confirmation: null };
export function aggregateDestinationReducer(state, event) {
  switch (event.type) {
    case 'choose': return ['editor', 'generate'].includes(event.destination) ? { destination: event.destination, confirmation: null } : state;
    case 'review': return state.destination === 'generate' ? { ...state, confirmation: event.confirmation } : state;
    case 'cancel': return { ...state, confirmation: null };
    default: return state;
  }
}


// Review and generation share a detached snapshot, including ordered entries
// and every media reference. Editing the assistant cannot alter an approval.
export function createAggregateConfirmation(draft, folder) {
  const snapshot = structuredClone(draft);
  const files = [...new Set([
    ...snapshot.packs.flatMap(pack => [pack.path, pack.coverImage, pack.coverAudio]),
    snapshot.rootAudio, snapshot.rootImage,
  ].filter(Boolean))];
  return { draft: snapshot, folder, fileName: `${getExportPackName(snapshot.metadata)}.zip`, files };
}
