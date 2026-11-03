import { sourceImportValue } from '../../i18n/importPresentation.js';
import { presentStoredError, presentUserMessage } from '../../i18n/userMessage.js';
import { mediaBindingViolations } from './mediaBindings.js';

// Porte de format pure, avant toute normalisation Libre. Le payload reste inerte.
const owns = (object, key) => Object.hasOwn(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Les données JSON invalides restent lisibles, sans conversion implicite [object Object].
const technicalFoundValue = value => value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);

export const PROJECT_FORMAT_FILE_FALLBACK = sourceImportValue({ key: 'import:format.file.fallback', params: { start: '<', end: '>' } });

export class ProjectFormatError extends Error {
  constructor(code, path, found, expected, fileName = PROJECT_FORMAT_FILE_FALLBACK, cause = null) {
    super();
    this.name = 'ProjectFormatError';
    const foundSource = sourceImportValue(found);
    const expectedSource = sourceImportValue(expected);
    this.params = { ...(cause?.params ?? {}), fileName: fileName === PROJECT_FORMAT_FILE_FALLBACK
      ? { key: 'import:format.file.fallback', params: { start: '<', end: '>' } } : fileName,
      path, found, expected, code };
    // Le code et les champs techniques restent disponibles ; aucune donnée du projet ne change.
    Object.assign(this, { code, path, found: foundSource, expected: expectedSource, fileName });
    const legacyDetail = sourceImportValue({ key: 'import:format.error.message', params: {
      fileName, path, found: foundSource, expected: expectedSource, code,
    } });
    Object.defineProperties(this, { detail: { enumerable: true, configurable: true, get: () =>
      cause?.detail ?? cause?.message ?? (typeof cause === 'string' ? cause
        : this.presentationRef ? presentStoredError(this.presentationRef) : legacyDetail) } });
    if (cause) this.cause = cause;
    // Les portes Imports portent des refs explicites ; les anciens producteurs hors lot
    // gardent leur présentation historique jusqu’à leur propre conversion.
    if (found?.key || expected?.key || cause) this.presentationRef = cause?.code
      ? { userMessage: cause, codedOnly: true }
      : { key: 'import:format.error.message', params: this.params };
    // Un code local homonyme ne constitue pas un contrat IPC.
    Object.defineProperty(this, 'message', { configurable: true, get: () => cause?.code
      ? presentUserMessage(cause).message
      : !cause && this.presentationRef ? presentStoredError(this.presentationRef) : legacyDetail });
  }
}

// Discrimination de mode d'un projet déjà installé. La forme complète a été
// vérifiée par la porte ci-dessous à l'entrée ; en mémoire, seul le mode reste
// à lire, et un projet Libre n'a jamais à payer la traversée des liaisons.
export function isAdvancedProject(project) {
  return project?.authoringMode === 'advanced';
}

// L'ancien nœud Lien (`type: 'ref'`) est un essai retiré du modèle : un projet
// qui en contient encore un est refusé à l'ouverture, avant toute normalisation
// (qui le confondrait avec une histoire), sans retrait silencieux ni conversion.
// Toutes les formes de liste lues par la migration sont parcourues.
const LEGACY_LINK_ENTRY_TYPE = 'ref';
const ENTRY_LIST_KEYS = ['rootEntries', 'sharedEntries', 'rootItems', 'menus', 'entries'];
const CHILD_LIST_KEYS = ['children', 'items'];

function findLegacyLinkEntryPath(entries, path) {
  if (!Array.isArray(entries)) return null;
  for (const [index, entry] of entries.entries()) {
    if (!isObject(entry)) continue;
    const entryPath = `${path}/${index}`;
    if (entry.type === LEGACY_LINK_ENTRY_TYPE) return entryPath;
    for (const key of CHILD_LIST_KEYS) {
      const found = findLegacyLinkEntryPath(entry[key], `${entryPath}/${key}`);
      if (found) return found;
    }
  }
  return null;
}

function legacyLinkEntryPath(project) {
  if (!isObject(project)) return null;
  for (const key of ENTRY_LIST_KEYS) {
    const found = findLegacyLinkEntryPath(project[key], `/${key}`);
    if (found) return found;
  }
  return null;
}

export function readProjectEnvelope(project, { fileName = PROJECT_FORMAT_FILE_FALLBACK } = {}) {
  const fail = (code, path, found, expected) => {
    throw new ProjectFormatError(code, path, found, expected, fileName);
  };
  if (!isObject(project)) fail('INVALID_PROJECT_SHAPE', '/', typeof project, { key: 'import:format.value.jsonObject' });
  const hasVersion = owns(project, 'schemaVersion');
  const version = project.schemaVersion;
  if (hasVersion && !Number.isSafeInteger(version)) {
    fail('INVALID_SCHEMA_VERSION', '/schemaVersion', technicalFoundValue(version), { key: 'import:format.value.safeInteger' });
  }
  if (hasVersion && version > 4) fail('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', version, { key: 'import:format.value.supportedVersion' });
  const mode = owns(project, 'authoringMode') ? project.authoringMode : 'free';
  if (mode !== 'free' && mode !== 'advanced') {
    fail('INVALID_AUTHORING_MODE', '/authoringMode', technicalFoundValue(mode), { key: 'import:format.value.authoringMode' });
  }
  const hasAuthoring = owns(project, 'authoring');
  if (hasAuthoring && !isObject(project.authoring)) {
    fail('INVALID_AUTHORING_BLOCK', '/authoring', technicalFoundValue(project.authoring), { key: 'import:format.value.object' });
  }
  if (version === 4 && !owns(project, 'authoringMode')) {
    fail('MISSING_AUTHORING_MODE', '/authoringMode', { key: 'import:format.value.absent' }, { key: 'import:format.value.explicitMode' });
  }
  if (mode === 'free') {
    if (hasAuthoring || project.projectType === 'advanced') {
      fail('CONTRADICTORY_PROJECT_ENVELOPE', '/authoring', { key: 'import:format.value.advancedInFree' }, { key: 'import:format.value.absentBlock' });
    }
    const legacyLinkPath = legacyLinkEntryPath(project);
    if (legacyLinkPath) {
      const error = new ProjectFormatError('LEGACY_LINK_NODE', legacyLinkPath, { key: 'import:format.legacyLink.found' }, { key: 'import:format.legacyLink.expected' }, fileName);
      // Message clair à l'auteur ; chemin et code restent dans le détail technique.
      const technicalRef = error.presentationRef;
      error.presentationRef = { key: 'import:format.legacyLink.unsupported' };
      Object.defineProperties(error, { detail: { enumerable: true, configurable: true, get: () => presentStoredError(technicalRef) } });
      throw error;
    }
    return { authoringMode: 'free', project };
  }
  if (version !== 4 || !hasAuthoring) {
    fail('CONTRADICTORY_PROJECT_ENVELOPE', '/authoring', hasAuthoring ? { key: 'import:format.value.freeSchema' } : { key: 'import:format.value.absent' }, { key: 'import:format.value.advancedSchema' });
  }
  if (project.projectType !== 'advanced' || !Array.isArray(project.rootEntries) || project.rootEntries.length !== 0) {
    fail('CONTRADICTORY_PROJECT_ENVELOPE', '/rootEntries', { key: 'import:format.value.incompatibleTree' }, { key: 'import:format.value.emptyTree' });
  }
  for (const key of ['nativeGraph', 'rootItems', 'menus', 'entries']) {
    if (project[key] != null && (!Array.isArray(project[key]) || project[key].length)) {
      fail('CONTRADICTORY_PROJECT_ENVELOPE', `/${key}`, { key: 'import:format.value.concurrentProjection' }, { key: 'import:format.value.noParallelGraph' });
    }
  }
  if (typeof project.authoring.payload !== 'string') {
    fail('INVALID_AUTHORING_PAYLOAD', '/authoring/payload', typeof project.authoring.payload, { key: 'import:format.value.opaqueJson' });
  }
  // La forme détaillée de la vue reste révisable ; son absence est admise.
  if (owns(project.authoring, 'editorState') && !isObject(project.authoring.editorState)) {
    fail('INVALID_EDITOR_STATE', '/authoring/editorState', typeof project.authoring.editorState, { key: 'import:format.value.optionalObject' });
  }
  if (!Array.isArray(project.authoring.mediaBindings)) {
    fail('INVALID_MEDIA_BINDINGS', '/authoring/mediaBindings', typeof project.authoring.mediaBindings, { key: 'import:format.value.array' });
  }
  // Forme de chaque liaison : sans elle, une référence vide ou dupliquée
  // survivrait au fichier et rendrait l'association Stage → média indécidable.
  for (const violation of mediaBindingViolations(project.authoring.mediaBindings)) {
    fail(violation.code, violation.path, violation.foundRef ?? violation.found, violation.expectedRef ?? violation.expected);
  }
  for (const key of ['nodes', 'edges', 'stage_id_map', 'stageIdMap', 'source_value', 'sourceValue', 'preparedGraphDocument']) {
    for (const [path, object] of [['', project], ['/authoring', project.authoring], ['/authoring/editorState', project.authoring.editorState ?? {}]]) {
      if (owns(object, key)) fail('DERIVED_GRAPH_IN_PROJECT', `${path}/${key}`, { key: 'import:format.value.derivedView' }, { key: 'import:format.value.payloadOnly' });
    }
  }
  return { authoringMode: 'advanced', project };
}

// Les anciens appelants ne peuvent pas installer un avancé en passant par le
// normaliseur hiérarchique : ils passent désormais par le codec et par
// l'état de travail, et cette porte reste ce qui interdit le retour en arrière.
export function assertFreeProjectEnvelope(project) {
  if (readProjectEnvelope(project).authoringMode !== 'free') {
    throw new ProjectFormatError('ADVANCED_CODEC_REQUIRED', '/authoringMode', 'advanced', { key: 'import:format.value.advancedCodec' });
  }
}
