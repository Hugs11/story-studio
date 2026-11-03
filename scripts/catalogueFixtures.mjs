import { initialFilterState } from '../src/store/catalogue/filterState.js';
// Fabrique d'entrées publiées par `catalogue_list_entries`, pour les tests de
// la logique du catalogue. Les valeurs sont écrites à la main par chaque test.

import { normalizeEntry } from '../src/store/catalogue/entryModel.js';

const TECHNICAL = { project: 'project', zip: 'zip', sevenZip: '7z', folder: 'studioDirectory', fs: 'fsDirectory' };

let counter = 0;

/**
 * @param {{format?: string, path?: string, member?: string, sources?: string[], available?: boolean,
 *   modifiedAt?: number, sizeBytes?: number|null, state?: string, retired?: boolean, uuid?: string,
 *   projectType?: string, authoringMode?: string, id?: string, addedAt?: number|null}} spec
 */
export function rawExemplar(spec = {}) {
  counter += 1;
  const fields = {};
  if (spec.projectType) fields['/projectType'] = { presence: 'present', rawValue: spec.projectType, validity: 'valid', source: '/projectType' };
  if (spec.authoringMode) fields['/authoringMode'] = { presence: 'present', rawValue: spec.authoringMode, validity: 'valid', source: '/authoringMode' };
  if (spec.damagedMedia !== undefined) fields['/packMetadata/damagedMedia'] = { presence: 'present', rawValue: spec.damagedMedia, validity: 'valid', source: 'imageDecode:v1' };
  const available = spec.available ?? true;
  return {
    id: spec.id ?? `ex-${counter}`,
    locator: { path: spec.path ?? `/packs/p${counter}.zip`, pathKey: [1], memberKey: spec.member ? 'k' : null, member: spec.member ?? null },
    retired: spec.retired ?? false,
    state: spec.state ?? (available ? 'available' : 'unavailable'),
    availability: available ? 'available' : 'unavailable',
    format: TECHNICAL[spec.format ?? 'zip'] ?? spec.format,
    modifiedAt: spec.modifiedAt ?? 1_700_000_000_000,
    addedAt: spec.addedAt ?? 1_700_000_000,
    sizeBytes: spec.sizeBytes === undefined ? 1000 : spec.sizeBytes,
    versionDeclared: null,
    sourceIds: spec.sources ?? ['A'],
    container: spec.member ? { path: spec.path ?? null } : null,
    observation: {
      format: TECHNICAL[spec.format ?? 'zip'],
      state: 'available',
      fields,
      identity: spec.uuid ? { raw: spec.uuid, value: spec.uuid, source: '/uuid', reliable: true } : null,
    },
  };
}

/** Entrée brute d'une fiche. */
export function rawEntry(spec = {}) {
  counter += 1;
  const values = {};
  if (spec.title !== undefined) values.title = spec.title;
  if (spec.ageMin !== undefined) values.ageMin = spec.ageMin;
  if (spec.ageMax !== undefined) values.ageMax = spec.ageMax;
  return {
    id: spec.id ?? `card-${counter}`,
    favorite: spec.favorite ?? false,
    addedAt: spec.addedAt === undefined ? 1_700_000_000 : spec.addedAt,
    referenceExemplarId: null,
    referenceUnavailable: spec.referenceUnavailable ?? false,
    values,
    ageFromName: spec.ageFromName ?? null,
    ageConflict: spec.ageConflict ?? false,
    language: spec.language ?? null,
    description: spec.description ?? null,
    author: spec.author ?? null,
    durationSeconds: spec.durationSeconds ?? null,
    storyCount: null,
    keywords: spec.keywords,
    tags: spec.tags,
    packState: spec.packState,
    exemplars: (spec.exemplars ?? [{}]).map(rawExemplar),
  };
}

export function card(spec) {
  return normalizeEntry(rawEntry(spec));
}

/** Vue complète minimale fournie aux surfaces de barre d'outils. */
export function catalogueViewFixture() {
  return { ...initialFilterState(), result: { counts: { fiches: 0 } } };
}
