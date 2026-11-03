import { rustMessageEnvelope } from '../../i18n/userMessage.js';
import { ensureProjectStorage, isValidProjectStorage, normalizeProjectStorage, readableProjectStorageFields } from '../projectStorage.js';
import { migrateProjectData, normalizeProjectData, projectToSerializable } from './schema.js';
import { PROJECT_FORMAT_FILE_FALLBACK, ProjectFormatError, readProjectEnvelope } from './envelope.js';

async function validateViaTauri(payload) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('validate_advanced_payload', { payload });
}

function withFreeMediaFields(project, source) {
  for (const key of ['mediaTags', 'mediaLibraryPaths']) {
    if (Object.hasOwn(source, key)) project[key] = structuredClone(source[key]);
  }
  return project;
}

// Corps sérialisable du projet, et seul endroit où le mode décide de la forme
// écrite. Un projet Libre passe par le normaliseur hiérarchique ; un projet
// avancé est recopié tel quel, sa vérité étant la chaîne déjà validée. Le clone
// protège l'état en mémoire des réécritures de chemins faites par l'appelant.
export function projectFileBody(project, { fileName = PROJECT_FORMAT_FILE_FALLBACK } = {}) {
  const { authoringMode } = readProjectEnvelope(project, { fileName });
  return structuredClone(authoringMode === 'advanced' ? project : projectToSerializable(project));
}

// Un `.mbah` dont le JSON externe est invalide ou tronqué est refusé ici, avant
// toute lecture d'enveloppe : aperçu et ouverture rendent donc le même refus.
function parseProjectFile(text, fileName) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProjectFormatError('INVALID_PROJECT_JSON', '/', error.message, { key: 'import:format.value.completeJson' }, fileName);
  }
}

export function projectPreviewThumbnail(project) {
  const label = (value) => (typeof value === 'string' && value.trim() ? value : null);
  const explicit = label(project?.thumbnailImage) ?? label(project?.rootImage);
  if (explicit) return explicit;

  try {
    const payload = typeof project?.authoring?.payload === 'string'
      ? JSON.parse(project.authoring.payload)
      : project?.authoring?.payload;
    const entry = payload?.document?.stageNodes?.find((stage) => stage?.squareOne === true);
    const assetRef = label(entry?.image);
    if (!assetRef) return null;
    const binding = project?.authoring?.mediaBindings?.find((candidate) => (
      candidate?.assetRef === assetRef && candidate?.status === 'resolved'
    ));
    return label(binding?.path);
  } catch {
    // L'aperçu ne valide pas le payload avancé : une chaîne illisible sera
    // refusée par l'ouverture normale, mais ne doit pas casser la liste.
    return null;
  }
}

// Aperçu d'un fichier projet, destiné aux listes (reprises de session, vignettes
// de l'accueil). Il lit l'enveloppe et la seule liaison de couverture du graphe : pas de migration — donc
// aucun `packMetadata.uuid` inventé au passage —, pas de normalisation, aucun
// appel Rust et aucune écriture. Énumérer des reprises laisse ainsi les octets
// du snapshot et l'identité qu'il porte exactement où ils sont. Un fichier
// refusé par l'enveloppe lève, comme à l'ouverture : l'appelant décide s'il
// affiche un libellé de repli ou remonte l'erreur.
export function readProjectFilePreview(text, { fileName = PROJECT_FORMAT_FILE_FALLBACK } = {}) {
  const raw = parseProjectFile(text, fileName);
  const { authoringMode } = readProjectEnvelope(raw, { fileName });
  const label = (value) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    authoringMode,
    projectName: label(raw.projectName),
    projectType: label(raw.projectType),
    thumbnailImage: projectPreviewThumbnail(raw),
  };
}

// Un descripteur `storage` invalide (retouche manuelle, version future) ne
// bloque pas l'ouverture : il est retiré, puis reconstruit en mémoire comme
// celui d'un ancien projet en gardant ses champs lisibles (`workId` compris).
// Aucune écriture disque ; persisté au prochain enregistrement.
function withReadableStorage(raw, fileName) {
  if (raw.storage == null || isValidProjectStorage(raw.storage)) return { source: raw, repaired: null };
  import('../../utils/logger.js')
    .then(({ logger }) => logger.warn('project:storage-invalid-repaired', fileName))
    .catch(() => {});
  const source = { ...raw };
  delete source.storage;
  return { source, repaired: readableProjectStorageFields(raw.storage) };
}

// Lecture mémoire seulement. Le résumé est séparé du projet et ne sera pas écrit.
// `resolveMediaPaths` est appelé **après** l'identification de l'enveloppe et la
// validation du payload : un fichier refusé n'est ni résolu, ni installé.
export async function decodeProjectFile(text, {
  fileName = PROJECT_FORMAT_FILE_FALLBACK,
  validateAdvancedPayload = validateViaTauri,
  resolveMediaPaths = null,
  ...migrationOptions
} = {}) {
  const raw = parseProjectFile(text, fileName);
  const { authoringMode } = readProjectEnvelope(raw, { fileName });
  let summary = null;
  if (authoringMode === 'advanced') {
    try {
      summary = await validateAdvancedPayload(raw.authoring.payload);
    } catch (error) {
      const cause = rustMessageEnvelope(error) ?? error;
      throw new ProjectFormatError(
        cause?.code ?? 'PAYLOAD_VALIDATION_FAILED', cause?.path ?? cause?.params?.path ?? '/authoring/payload',
        cause?.found ?? cause?.params?.found ?? { userMessage: error, codedOnly: true },
        cause?.expected ?? cause?.params?.expected ?? { key: 'import:format.value.validProject' }, fileName, cause,
      );
    }
  }
  const { source: resolved, repaired } = withReadableStorage(resolveMediaPaths ? await resolveMediaPaths(raw) : raw, fileName);
  const base = authoringMode === 'advanced' ? resolved : normalizeProjectData(migrateProjectData(resolved, migrationOptions));
  const ensured = ensureProjectStorage(base, { saved: !!migrationOptions.savePath });
  const stored = repaired ? { ...ensured, storage: { ...ensured.storage, ...repaired } } : ensured;
  if (authoringMode === 'advanced') return { project: { ...stored, officialProvenance: summary?.officialProvenance ?? 'unknown', ...(summary?.officialOriginUuid ? { officialOriginUuid: summary.officialOriginUuid } : {}), ...(summary?.containsOfficialContent ? { containsOfficialContent: true } : {}), storage: normalizeProjectStorage(stored.storage) }, summary };
  return {
    project: withFreeMediaFields(stored, resolved),
    summary,
  };
}

// Le payload avancé validé en mémoire est recopié à l'identique ; aucun appel
// Rust à l'écriture, aucune préparation d'export, aucune génération d'identité.
export function encodeProjectFile(project, options = {}) {
  return JSON.stringify(withFreeMediaFields(projectFileBody(project, options), project), null, 2);
}
