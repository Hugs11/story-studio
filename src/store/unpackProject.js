import { replaceEntryWithEntries } from './projectModel/operations.js';
import { basenameNoExt } from '../utils/fileUtils.js';
import { parseConventionName } from '../utils/packConvention.js';
import { sanitizeImportedName } from './importedNames.js';

export function getUnpackedPackDetails({ result = {}, zipPath = '', zipName = '' } = {}) {
  const zipFilename = basenameNoExt(zipPath);
  const rawTitle = String(result?.title || '').trim();
  const parsedZipFilename = parseConventionName(zipFilename);
  const parsedPackName = parseConventionName(rawTitle) ?? parsedZipFilename;
  const isZipConvention = /^\d+\+\]/.test(zipFilename);
  const isTitleConvention = /^\d+\+\]/.test(rawTitle);
  const packName = (rawTitle && (isTitleConvention || !isZipConvention))
    ? sanitizeImportedName(rawTitle, zipName || 'Pack importé')
    : sanitizeImportedName(zipFilename || zipName, 'Pack importé');
  const packMetadata = parsedPackName
    ? {
        ...parsedPackName,
        version: result?.packVersion ?? parsedPackName.version,
        description: result?.packDescription ?? '',
        namingMode: 'convention',
      }
    : {
        title: packName,
        author: '',
        version: result?.packVersion ?? 1,
        minAge: ((zipFilename || zipName || '').match(/^(\d+)\+\]/)?.[1]) || '3',
        producer: '',
        bonus: '',
        description: result?.packDescription ?? '',
        namingMode: 'convention',
        legacyExportName: '',
        legacyName: '',
      };

  return {
    zipFilename,
    rawTitle,
    parsedZipFilename,
    parsedPackName,
    packName,
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
  sharedEntries = [],
  zipPath = '',
  zipName = '',
  result = {},
  savedDuringUnpack = false,
}) {
  const details = getUnpackedPackDetails({ result, zipPath, zipName });
  const shouldPromote = isBlankProjectForZipPromotion(project, menuId, { savedDuringUnpack });
  const nextProject = shouldPromote
    ? {
        ...project,
        projectType: 'pack',
        projectName: project?.projectName ?? '',
        packMetadata: details.packMetadata,
        rootAudio: result?.rootAudio ?? null,
        rootImage: result?.rootImage ?? null,
        thumbnailImage: result?.thumbnailImage ?? result?.rootImage ?? null,
        sameImage: !!(result?.rootImage) && !result?.thumbnailImage,
        nativeGraph: result?.nativeGraph ?? null,
        rootEntries: entries,
        sharedEntries,
      }
    : {
        ...replaceEntryWithEntries(project, menuId, itemId, entries),
        sharedEntries: [
          ...(project?.sharedEntries ?? []),
          ...sharedEntries,
        ],
      };

  return {
    project: nextProject,
    ...details,
  };
}
