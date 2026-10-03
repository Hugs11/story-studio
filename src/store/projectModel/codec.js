import { migrateProjectData, normalizeProjectData, projectToSerializable } from './schema.js';
import { ProjectFormatError, readProjectEnvelope } from './envelope.js';

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
export function projectFileBody(project, { fileName = '<projet>' } = {}) {
  const { authoringMode } = readProjectEnvelope(project, { fileName });
  return structuredClone(authoringMode === 'advanced' ? project : projectToSerializable(project));
}

// Un `.mbah` dont le JSON externe est invalide ou tronqué est refusé ici, avant
// toute lecture d'enveloppe : aperçu et ouverture rendent donc le même refus.
function parseProjectFile(text, fileName) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProjectFormatError('INVALID_PROJECT_JSON', '/', error.message, 'JSON complet', fileName);
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
export function readProjectFilePreview(text, { fileName = '<projet>' } = {}) {
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

// Lecture mémoire seulement. Le résumé est séparé du projet et ne sera pas écrit.
// `resolveMediaPaths` est appelé **après** l'identification de l'enveloppe et la
// validation du payload : un fichier refusé n'est ni résolu, ni installé.
export async function decodeProjectFile(text, {
  fileName = '<projet>',
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
      throw new ProjectFormatError(
        error?.code ?? 'PAYLOAD_VALIDATION_FAILED', error?.path ?? '/authoring/payload',
        error?.found ?? String(error), error?.expected ?? 'projet valide', fileName,
      );
    }
  }
  const resolved = resolveMediaPaths ? await resolveMediaPaths(raw) : raw;
  if (authoringMode === 'advanced') return { project: resolved, summary };
  return {
    project: withFreeMediaFields(normalizeProjectData(migrateProjectData(resolved, migrationOptions)), resolved),
    summary,
  };
}

// Le payload avancé validé en mémoire est recopié à l'identique ; aucun appel
// Rust à l'écriture, aucune préparation d'export, aucune génération d'identité.
export function encodeProjectFile(project, options = {}) {
  return JSON.stringify(withFreeMediaFields(projectFileBody(project, options), project), null, 2);
}
