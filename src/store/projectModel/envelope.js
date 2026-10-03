import { mediaBindingViolations } from './mediaBindings.js';

// Porte de format pure, avant toute normalisation Libre. Le payload reste inerte.
const owns = (object, key) => Object.hasOwn(object, key);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ProjectFormatError extends Error {
  constructor(code, path, found, expected, fileName = '<projet>') {
    super(`${fileName} — ${path} : trouvé ${found}, attendu ${expected} (${code})`);
    this.name = 'ProjectFormatError';
    Object.assign(this, { code, path, found, expected, fileName });
  }
}

// Discrimination de mode d'un projet déjà installé. La forme complète a été
// vérifiée par la porte ci-dessous à l'entrée ; en mémoire, seul le mode reste
// à lire, et un projet Libre n'a jamais à payer la traversée des liaisons.
export function isAdvancedProject(project) {
  return project?.authoringMode === 'advanced';
}

export function readProjectEnvelope(project, { fileName = '<projet>' } = {}) {
  const fail = (code, path, found, expected) => {
    throw new ProjectFormatError(code, path, found, expected, fileName);
  };
  if (!isObject(project)) fail('INVALID_PROJECT_SHAPE', '/', typeof project, 'objet JSON');
  const hasVersion = owns(project, 'schemaVersion');
  const version = project.schemaVersion;
  if (hasVersion && !Number.isSafeInteger(version)) {
    fail('INVALID_SCHEMA_VERSION', '/schemaVersion', String(version), 'entier sûr');
  }
  if (hasVersion && version > 4) fail('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', version, 'version ≤ 4');
  const mode = owns(project, 'authoringMode') ? project.authoringMode : 'free';
  if (mode !== 'free' && mode !== 'advanced') {
    fail('INVALID_AUTHORING_MODE', '/authoringMode', String(mode), 'free ou advanced');
  }
  const hasAuthoring = owns(project, 'authoring');
  if (hasAuthoring && !isObject(project.authoring)) {
    fail('INVALID_AUTHORING_BLOCK', '/authoring', String(project.authoring), 'objet');
  }
  if (version === 4 && !owns(project, 'authoringMode')) {
    fail('MISSING_AUTHORING_MODE', '/authoringMode', 'absent', 'mode explicite pour le schéma 4');
  }
  if (mode === 'free') {
    if (hasAuthoring || project.projectType === 'advanced') {
      fail('CONTRADICTORY_PROJECT_ENVELOPE', '/authoring', 'contenu avancé en mode Libre', 'bloc absent');
    }
    return { authoringMode: 'free', project };
  }
  if (version !== 4 || !hasAuthoring) {
    fail('CONTRADICTORY_PROJECT_ENVELOPE', '/authoring', hasAuthoring ? 'schéma Libre' : 'absent', 'schéma 4 et bloc avancé');
  }
  if (project.projectType !== 'advanced' || !Array.isArray(project.rootEntries) || project.rootEntries.length !== 0) {
    fail('CONTRADICTORY_PROJECT_ENVELOPE', '/rootEntries', 'arbre ou type incompatible', 'projectType advanced et rootEntries vide');
  }
  for (const key of ['nativeGraph', 'rootItems', 'menus', 'entries']) {
    if (project[key] != null && (!Array.isArray(project[key]) || project[key].length)) {
      fail('CONTRADICTORY_PROJECT_ENVELOPE', `/${key}`, 'projection concurrente', 'aucun graphe parallèle');
    }
  }
  if (typeof project.authoring.payload !== 'string') {
    fail('INVALID_AUTHORING_PAYLOAD', '/authoring/payload', typeof project.authoring.payload, 'chaîne JSON opaque');
  }
  // La forme détaillée de la vue reste révisable ; son absence est admise.
  if (owns(project.authoring, 'editorState') && !isObject(project.authoring.editorState)) {
    fail('INVALID_EDITOR_STATE', '/authoring/editorState', typeof project.authoring.editorState, 'objet ou absence');
  }
  if (!Array.isArray(project.authoring.mediaBindings)) {
    fail('INVALID_MEDIA_BINDINGS', '/authoring/mediaBindings', typeof project.authoring.mediaBindings, 'tableau');
  }
  // Forme de chaque liaison : sans elle, une référence vide ou dupliquée
  // survivrait au fichier et rendrait l'association Stage → média indécidable.
  for (const violation of mediaBindingViolations(project.authoring.mediaBindings)) {
    fail(violation.code, violation.path, violation.found, violation.expected);
  }
  for (const key of ['nodes', 'edges', 'stage_id_map', 'stageIdMap', 'source_value', 'sourceValue', 'preparedGraphDocument']) {
    for (const [path, object] of [['', project], ['/authoring', project.authoring], ['/authoring/editorState', project.authoring.editorState ?? {}]]) {
      if (owns(object, key)) fail('DERIVED_GRAPH_IN_PROJECT', `${path}/${key}`, 'vue dérivée', 'document dans le payload seulement');
    }
  }
  return { authoringMode: 'advanced', project };
}

// Les anciens appelants ne peuvent pas installer un avancé en passant par le
// normaliseur hiérarchique : ils passent désormais par le codec et par
// l'état de travail, et cette porte reste ce qui interdit le retour en arrière.
export function assertFreeProjectEnvelope(project) {
  if (readProjectEnvelope(project).authoringMode !== 'free') {
    throw new ProjectFormatError('ADVANCED_CODEC_REQUIRED', '/authoringMode', 'advanced', 'codec avancé avant installation');
  }
}
