import { containsOfficialContent, officialIdentityFields } from './officialProvenance.js';
import { replaceEntryWithEntries } from './projectModel/operations.js';
import {
  ProjectMenuDepthError,
  validateMenuDepthPlacement,
} from './projectModel/menuDepth.js';
import { basenameNoExt } from '../utils/fileUtils.js';
import { parseConventionName } from '../utils/packConvention.js';
import { resolveImportedPackMetadata } from './importedPackMetadata.js';
import { generateUuid } from '../utils/uuid.js';

export function getUnpackedPackDetails({ result = {}, zipPath = '', zipName = '' } = {}) {
  const zipFilename = basenameNoExt(zipName || zipPath);
  const rawTitle = String(result?.title || '').trim();
  const packMetadata = {
    ...resolveImportedPackMetadata({
      pack: {
        title: result.title, version: result.packVersion,
        minAge: result.minAge, maxAge: result.maxAge, author: result.author, description: result.packDescription,
      },
      catalogue: result.catalogueMetadata,
      fileName: zipName || zipPath,
    }),
    uuid: result.uuid ?? result.packUuid ?? '',
    originalUuid: result.uuid ?? result.packUuid ?? '',
  };
  return {
    zipFilename, rawTitle,
    parsedZipFilename: parseConventionName(zipFilename),
    parsedPackName: parseConventionName(rawTitle) ?? parseConventionName(zipFilename),
    packName: packMetadata.title,
    packMetadata,
  };
}

export function isBlankProjectForZipPromotion(project, menuId, { savedDuringUnpack = false } = {}) {
  const localProjectName = String(project?.projectName || '').trim();
  return menuId == null
    && (project?.rootEntries ?? []).length <= 1
    && (savedDuringUnpack || !localProjectName)
    && !project?.packMetadata?.title
    && !project?.rootAudio
    && !project?.rootImage;
}

export function buildProjectAfterZipUnpack({
  project,
  menuId,
  itemId,
  entries,
  zipPath = '',
  zipName = '',
  result = {},
  savedDuringUnpack = false,
}) {
  const shouldPromote = isBlankProjectForZipPromotion(project, menuId, { savedDuringUnpack });
  const details = getUnpackedPackDetails({ result: shouldPromote ? result : { ...result, catalogueMetadata: null }, zipPath, zipName });
  const depthDiagnostic = validateMenuDepthPlacement(
    project,
    shouldPromote ? null : menuId,
    entries,
  );
  if (!depthDiagnostic.allowed) throw new ProjectMenuDepthError(depthDiagnostic);
  // Un pack sans identité lisible n'en impose pas une vide : le projet garde la
  // sienne, et `originalUuid` reste vide puisque le pack n'en apportait pas.
  const packMetadata = {
    ...details.packMetadata,
    uuid: details.packMetadata.uuid || project?.packMetadata?.uuid || generateUuid(),
  };
  // Stamp every root: deleting the entire imported subtree removes containment.
  const importedEntries = result?.officialProvenance === 'official'
    ? entries.map(entry => ({ ...entry, officialProvenance: result.officialProvenance, officialOriginUuid: result.officialOriginUuid || details.packMetadata.uuid }))
    : entries;
  const nextProject = shouldPromote
    ? {
        ...project,
        projectType: 'pack',
        projectName: project?.projectName ?? '',
        packMetadata,
        officialProvenance: result?.officialProvenance ?? 'unknown',
        ...officialIdentityFields(result),
        rootAudio: result?.rootAudio ?? null,
        rootImage: result?.rootImage ?? null,
        thumbnailImage: result?.thumbnailImage ?? result?.rootImage ?? null,
        sameImage: !!(result?.rootImage) && !result?.thumbnailImage,
        nativeGraph: result?.nativeGraph ?? null,
        rootEntries: importedEntries,
      }
    : replaceEntryWithEntries(project, menuId, itemId, importedEntries);

  nextProject.containsOfficialContent = containsOfficialContent(nextProject);

  return {
    project: nextProject,
    promoted: shouldPromote,
    ...details,
  };
}
