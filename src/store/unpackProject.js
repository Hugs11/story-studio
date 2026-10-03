import { replaceEntryWithEntries } from './projectModel/operations.js';
import {
  ProjectMenuDepthError,
  validateMenuDepthPlacement,
} from './projectModel/menuDepth.js';
import { basenameNoExt } from '../utils/fileUtils.js';
import { parseConventionName, splitLeadingAge } from '../utils/packConvention.js';
import { sanitizeImportedName } from './importedNames.js';
import { generateUuid } from '../utils/uuid.js';

// Remonte un préfixe d'âge « libre » (« 3+ Example… », « 6+_Titre ») vers minAge et le
// retire du titre. Contrairement à la convention stricte « N+] » (gérée par
// parseConventionName), certains packs notent l'âge sans crochet ; sans ce traitement,
// le « 3+ » restait dans le titre et se dédoublait dans le nom exporté (« 3+]3+_… »).
function liftLeadingAge(name, fallbackAge = '3') {
  return splitLeadingAge(name) ?? { minAge: fallbackAge, title: String(name || '').trim() };
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
  // Un titre de convention réduit à l'âge (« 6+] ») n'a rien de lisible : le
  // nom de l'archive, s'il en porte un, sert de titre.
  const archiveTitle = parsedZipFilename?.title
    || liftLeadingAge(sanitizeImportedName(zipFilename, ''), fallbackAge).title;
  const packMetadata = parsedPackName
    ? {
        ...parsedPackName,
        title: String(parsedPackName.title || '').trim() ? parsedPackName.title : archiveTitle,
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

function isBlankProjectForZipPromotion(project, menuId, { savedDuringUnpack = false } = {}) {
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
  const nextProject = shouldPromote
    ? {
        ...project,
        projectType: 'pack',
        projectName: project?.projectName ?? '',
        packMetadata,
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
