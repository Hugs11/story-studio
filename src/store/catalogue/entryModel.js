import { generationState, generationFilterState } from './generationState.js';
// Modèle interne d'une fiche du catalogue des packs, construit à partir d'une
// entrée publiée par `catalogue_list_entries`.
//
// Les valeurs effectives publiées par le moteur comprennent les corrections,
// la référence et les compléments des autres exemplaires disponibles. Une
// référence introuvable garde ses dernières valeurs connues. Les bornes d'âge
// sont résolues champ par champ ; les contradictions restent signalées.

/** Ordre fixe d'affichage des formats : Projet, ZIP, 7z, Dossier. */
export const FORMAT_ORDER = Object.freeze(['project', 'zip', 'sevenZip', 'folder']);

// Formats techniques publiés par le moteur → famille affichée.
const FORMAT_FAMILIES = Object.freeze({
  project: 'project',
  zip: 'zip',
  fsZip: 'zip',
  '7z': 'sevenZip',
  studioDirectory: 'folder',
  fsDirectory: 'folder',
});

/** Types de projet reconnus dans un `.mbah` (mode d'édition). */
export const PROJECT_TYPES = Object.freeze(['simple', 'menus', 'graph']);

/** Âge maximal accepté (années), identique à la lecture des fichiers. */
export const AGE_LIMIT = 18;

export function formatFamily(format) {
  return Object.hasOwn(FORMAT_FAMILIES, format) ? FORMAT_FAMILIES[format] : null;
}

function formatRank(family) {
  const rank = FORMAT_ORDER.indexOf(family);
  return rank < 0 ? FORMAT_ORDER.length : rank;
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function integer(value) {
  return Number.isInteger(value) ? value : null;
}

function seconds(value) {
  return Number.isInteger(value) && value > 0 ? value * 1000 : null;
}

function fileName(path) {
  if (typeof path !== 'string' || !path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Valeur lue et valide d'un champ observé (même règle que le moteur).
function observedValue(observation, pointer) {
  const field = observation?.fields?.[pointer];
  return field?.validity === 'valid' ? field.rawValue : undefined;
}

// First damaged picture found while the pack was measured, or null.
function damagedMedia(observation) {
  const value = observedValue(observation, '/packMetadata/damagedMedia');
  if (value?.kind !== 'image') return null;
  return { kind: 'image', screen: typeof value.screen === 'string' && value.screen.trim() ? value.screen : null };
}

function projectType(observation) {
  if (observedValue(observation, '/authoringMode') === 'advanced') return 'graph';
  const type = observedValue(observation, '/projectType');
  if (type === 'simple') return 'simple';
  if (type === 'pack') return 'menus';
  return null;
}

function reliableUuid(observation) {
  const identity = observation?.identity;
  return identity?.reliable === true && typeof identity.value === 'string' ? identity.value : null;
}

function validAge(value, limit = AGE_LIMIT) {
  return Number.isInteger(value) && value >= 0 && value <= limit;
}

/**
 * Âge d'une fiche : `{min, max, kind, origin, conflict, reason}`.
 * - `unknown` : aucune information ;
 * - `partial` : une seule borne connue ;
 * - `range` : deux bornes cohérentes ;
 * - `invalid` : valeurs contradictoires ou hors limites (signalées dans les
 *   détails, distinctes des inconnues).
 * `origin` : `file` (fichier de référence) ou `name` (préfixe du nom, repli).
 */
export function normalizeAge(values, { ageFromName = null, ageConflict = false, personal = false, derivedOrigin = null } = {}) {
  const rawMin = values?.ageMin ?? null;
  const rawMax = values?.ageMax ?? null;
  // Le moteur ne publie `ageFromName` que lorsqu'il a servi de repli.
  const origin = rawMin === null && rawMax === null ? null : (derivedOrigin === 'lunii' ? 'lunii' : ageFromName !== null ? 'name' : 'file');
  const base = { origin, conflict: ageConflict === true };
  if (rawMin === null && rawMax === null) {
    return base.conflict
      ? { min: null, max: null, kind: 'invalid', reason: 'nameConflict', ...base }
      : { min: null, max: null, kind: 'unknown', reason: null, ...base };
  }
  if ((rawMin !== null && !validAge(rawMin, personal ? 2147483647 : AGE_LIMIT)) || (rawMax !== null && !validAge(rawMax, personal ? 2147483647 : AGE_LIMIT))) {
    return { min: null, max: null, kind: 'invalid', reason: 'outOfRange', ...base };
  }
  if (rawMin !== null && rawMax !== null) {
    return rawMin > rawMax
      ? { min: rawMin, max: rawMax, kind: 'invalid', reason: 'minAboveMax', ...base }
      : { min: rawMin, max: rawMax, kind: 'range', reason: null, ...base };
  }
  return { min: rawMin, max: rawMax, kind: 'partial', reason: null, ...base };
}

const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Chemin qui porte le nom présenté. Un dossier nommé par un UUID (packs
// officiels) n'est pas un nom : l'archive qui le contient, ou le dossier
// parent d'un pack dossier, le remplace.
function namedPath(path, member, containerPath) {
  const container = containerPath ?? path;
  if (member) return UUID_NAME.test(fileName(member) ?? '') ? container : null;
  if (!UUID_NAME.test(fileName(path) ?? '')) return path;
  const parent = path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '');
  return fileName(parent) ? parent : path;
}

function normalizeExemplar(raw) {
  const locator = raw?.locator ?? {};
  const family = formatFamily(raw?.format);
  const member = text(locator.member);
  const path = text(locator.path);
  const containerPath = raw?.container ? text(raw.container.path) : null;
  const named = namedPath(path, member, containerPath);
  return {
    id: String(raw?.id ?? ''),
    format: family,
    technicalFormat: typeof raw?.format === 'string' ? raw.format : null,
    path,
    member,
    containerPath,
    archiveRemoval: raw?.archiveRemoval ?? null,
    // Nom présenté et cherché : celui du pack dans l'archive, sinon du fichier
    // (voir namedPath) ; `namedPath` situe ce nom pour la ligne de dossier.
    namedPath: named,
    fileName: named ? fileName(named) : fileName(member),
    state: typeof raw?.state === 'string' ? raw.state : 'unavailable',
    available: raw?.availability === 'available' && raw?.retired !== true,
    retired: raw?.retired === true,
    // Official Lunii origin, decided by the engine with the send gate's rule.
    official: raw?.official === true,
    modifiedAt: Number.isInteger(raw?.modifiedAt) && raw.modifiedAt > 0 ? raw.modifiedAt : null,
    addedAt: seconds(raw?.addedAt),
    sizeBytes: Number.isInteger(raw?.sizeBytes) && raw.sizeBytes >= 0 ? raw.sizeBytes : null,
    versionDeclared: integer(raw?.versionDeclared),
    storyCount: integer(raw?.storyCount ?? observedValue(raw?.observation, '/packMetadata/storyCount')),
    durationSeconds: (() => {
      const value = raw?.durationSeconds ?? observedValue(raw?.observation, '/packMetadata/durationSeconds');
      return Number.isFinite(value) && value >= 0 ? value : null;
    })(),
    damagedMedia: damagedMedia(raw?.observation),
    sourceIds: Array.isArray(raw?.sourceIds) ? raw.sourceIds.filter((id) => typeof id === 'string') : [],
    ...(family === 'project' ? { generation: generationState(raw?.generation) } : {}),
    projectType: family === 'project' ? projectType(raw?.observation) : null,
    uuid: reliableUuid(raw?.observation),
  };
}

function compareText(left, right) {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
}

/**
 * Ordre des exemplaires : formats dans l'ordre fixe, puis du plus récent au
 * plus ancien, départage stable par chemin puis par membre et identifiant.
 */
export function compareExemplars(left, right) {
  return formatRank(left.format) - formatRank(right.format)
    || (right.modifiedAt ?? -Infinity) - (left.modifiedAt ?? -Infinity)
    || compareText(left.path, right.path)
    || compareText(left.member, right.member)
    || compareText(left.id, right.id);
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined))];
}

/** Titre affiché : « Aladin - Aladin » (titre = sous-titre) devient « Aladin ». */
export function displayTitle(value) {
  if (typeof value !== 'string') return value;
  const parts = value.split(' - ');
  return parts.length === 2 && parts[0].trim().toLowerCase() === parts[1].trim().toLowerCase()
    ? parts[0].trim() : value;
}

/**
 * Normalise une entrée publiée. Les exemplaires retirés (remplacés par une
 * nouvelle identité au même emplacement) ne sont pas présentés.
 * Étiquettes, mots-clés, langue et état projet/pack ne sont pas
 * encore publiés : listes vides et `null`, jamais inventés.
 */
export function normalizeEntry(raw) {
  const values = raw?.values && typeof raw.values === 'object' ? raw.values : {};
  const exemplars = (Array.isArray(raw?.exemplars) ? raw.exemplars : [])
    .map(normalizeExemplar)
    .filter((exemplar) => !exemplar.retired)
    .sort(compareExemplars);
  const formats = FORMAT_ORDER.filter((format) => exemplars.some((exemplar) => exemplar.format === format));
  return {
    id: String(raw?.id ?? ''),
    coverSignature: text(raw?.coverSignature),
    favorite: raw?.favorite === true,
    ficheRevision: integer(raw?.ficheRevision),
    corrections: Object.fromEntries(Object.entries(raw?.corrections ?? {}).filter(([, state]) => state === 'defined' || state === 'cleared')),
    addedAt: seconds(raw?.addedAt),
    title: text(values.title),
    displayTitle: displayTitle(text(values.title) ?? text(raw?.displayTitle)),
    subtitle: text(raw?.subtitle),
    titleConflict: raw?.titleConflict === true,
    description: text(raw?.description),
    author: text(raw?.author),
    producer: text(values.producer),
    bonus: text(values.bonus),
    language: text(raw?.language),
    durationSeconds: Number.isFinite(raw?.durationSeconds) && raw.durationSeconds >= 0 ? raw.durationSeconds : null,
    storyCount: integer(raw?.storyCount),
    keywords: Array.isArray(raw?.keywords) ? raw.keywords.filter((item) => typeof item === 'string') : [],
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((tag) => tag && typeof tag.id === 'string') : [],
    tagIds: Array.isArray(raw?.tagIds) ? raw.tagIds.filter(id => typeof id === 'string') : (raw?.tags ?? []).map(tag => tag.id),
    packState: generationFilterState(exemplars) ?? text(raw?.packState),
    cover: values.cover ?? null,
    referenceExemplarId: typeof raw?.referenceExemplarId === 'string' ? raw.referenceExemplarId : null,
    referenceUnavailable: raw?.referenceUnavailable === true,
    age: normalizeAge(values, { derivedOrigin: raw?.ageOrigin, ageFromName: integer(raw?.ageFromName), ageConflict: raw?.ageConflict === true, personal: ['defined', 'cleared'].includes(raw?.corrections?.ageMin) || ['defined', 'cleared'].includes(raw?.corrections?.ageMax) }),
    formats,
    exemplars,
    exemplarsByFormat: formats.map((format) => ({
      format,
      exemplars: exemplars.filter((exemplar) => exemplar.format === format),
    })),
    projectTypes: PROJECT_TYPES.filter((type) => exemplars.some((exemplar) => exemplar.projectType === type)),
    uuids: unique(exemplars.map((exemplar) => exemplar.uuid)),
    available: exemplars.some((exemplar) => exemplar.available),
    // Official Lunii story: never sent from the catalogue (the engine refuses it too).
    official: raw?.official === true,
    offlineReason: exemplars.some((exemplar) => exemplar.available) ? null : (raw?.offlineReason === 'missing' ? 'missing' : 'unavailable'),
  };
}

export function normalizeEntries(items) {
  return (Array.isArray(items) ? items : []).map(normalizeEntry);
}

// The current catalogue has at least one active source covering an exemplar.
// Durable cards without an exemplar remain addressable by IPC.
export function currentCatalogueCards(cards) {
  return cards.filter(card => card.exemplars.some(exemplar => exemplar.sourceIds.length > 0));
}

/** IDs des étiquettes, depuis un résumé ou une fiche détaillée. */
export function cardTagIds(card) {
  return card.tagIds ?? card.tags?.map(item => item.id) ?? [];
}
