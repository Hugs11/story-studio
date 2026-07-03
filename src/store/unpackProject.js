import { replaceEntryWithEntries } from './projectModel/operations.js';
import { basenameNoExt } from '../utils/fileUtils.js';
import { parseConventionName } from '../utils/packConvention.js';
import { sanitizeImportedName } from './importedNames.js';

// Remonte un préfixe d'âge « libre » (« 3+ Mickey… », « 6+_Titre ») vers minAge et le
// retire du titre. Contrairement à la convention stricte « N+] » (gérée par
// parseConventionName), certains packs notent l'âge sans crochet ; sans ce traitement,
// le « 3+ » restait dans le titre et se dédoublait dans le nom exporté (« 3+]3+_… »).
function liftLeadingAge(name, fallbackAge = '3') {
  // « N+ » suivi d'un séparateur (« ] » ou espace) et d'un titre : on remonte l'âge,
  // sans toucher « 3+5 » ni « 3+Mickey » (pas de séparateur = pas un préfixe d'âge).
  const match = String(name || '').match(/^\s*(\d{1,2})\s*\+(?:\]|\s)\s*(\S.*)$/);
  if (match && match[2].trim()) {
    return { minAge: match[1], title: match[2].trim() };
  }
  return { minAge: fallbackAge, title: String(name || '').trim() };
}

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
  const fallbackAge = (zipFilename || zipName || '').match(/^\s*(\d+)\s*\+/)?.[1] || '3';
  const lifted = liftLeadingAge(packName, fallbackAge);
  const packMetadata = parsedPackName
    ? {
        ...parsedPackName,
        version: result?.packVersion ?? parsedPackName.version,
        description: result?.packDescription ?? '',
        uuid: result?.uuid ?? result?.packUuid ?? '',
        originalUuid: result?.uuid ?? result?.packUuid ?? '',
        namingMode: 'convention',
      }
    : {
        title: lifted.title,
        author: '',
        version: result?.packVersion ?? 1,
        minAge: lifted.minAge,
        producer: '',
        bonus: '',
        description: result?.packDescription ?? '',
        uuid: result?.uuid ?? result?.packUuid ?? '',
        originalUuid: result?.uuid ?? result?.packUuid ?? '',
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
      }
    : replaceEntryWithEntries(project, menuId, itemId, entries);

  return {
    project: nextProject,
    promoted: shouldPromote,
    ...details,
  };
}
