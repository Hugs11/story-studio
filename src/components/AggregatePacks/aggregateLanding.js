import { isAbsoluteFilePath } from '../../utils/fileUtils.js';
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

// Les couvertures sont soit des fichiers du catalogue, soit des noms d'assets ZIP.
export async function copyAggregatePack(pack, copy) {
  return {
    ...pack,
    path: await copy(pack.path),
    coverImage: isAbsoluteFilePath(pack.coverImage) ? await copy(pack.coverImage) : pack.coverImage,
    coverAudio: isAbsoluteFilePath(pack.coverAudio) ? await copy(pack.coverAudio) : pack.coverAudio,
  };
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
    packs.push(await copyAggregatePack(pack, promote));
  }
  return buildAggregateProject({
    packs,
    rootAudio: await promote(draft.rootAudio),
    rootImage: await promote(draft.rootImage),
    metadata: draft.metadata,
  });
}

// Guards run before a new work session is created. A cancelled guard
// never installs a project or starts a native task.
export async function landAggregate({ confirmBackgroundWork, confirmSave, runLanding, prepare, install }) {
  if (!await confirmBackgroundWork() || !await confirmSave()) return false;
  await runLanding('pack', async (workspaceDir, session) => {
    const project = await prepare(workspaceDir);
    if (session?.isCurrent && !session.isCurrent()) throw { code: 'CATALOG_ASSEMBLY_SESSION_INVALID', params: {} };
    await install(project);
  }, { applyProjectType: false, forceEphemeral: true, errorLog: 'aggregate:land-error' });
  return true;
}

export function aggregateSteps() {
  return [
    { key: 'packs', labelKey: 'home:aggregate.step.packs' },
    { key: 'audio', labelKey: 'home:aggregate.step.audio' },
    { key: 'image', labelKey: 'home:aggregate.step.image' },
    { key: 'metadata', labelKey: 'home:aggregate.step.metadata' },
  ];
}

export function canVisitAggregateStep({ index, packs, rootAudio, rootImage }) {
  const target = aggregateSteps()[index]?.key;
  if (!target) return false;
  if (target === 'packs') return true;
  if (!packs.length) return false;
  if (target === 'image' && !rootAudio) return false;
  if (target === 'metadata' && (!rootAudio || !rootImage)) return false;
  return true;
}

// Capture the ordered draft when generation starts.
export function createAggregateGenerationRequest(draft, folder) {
  return { draft: structuredClone(draft), folder };
}
