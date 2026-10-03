import { visitProjectEntries } from './projectModel/index.js';
import { isAdvancedProject } from './projectModel/envelope.js';
import { isProjectOpen } from './projectWorkState.js';
import { readMediaBindings } from './projectModel/mediaBindings.js';
import { isOriginalBackup } from '../utils/mediaConventions.js';
import { pathKey } from '../utils/fileUtils.js';
import { reconcileMediaLibraryPaths } from './mediaLibrary.js';

export function classifyOsDroppedFiles(paths) {
  const ext = (p) => (String(p).split('.').pop() || '').toLowerCase();
  const AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'webm']);
  const IMAGES = new Set(['png', 'jpg', 'jpeg', 'webp']);
  const ARCHIVES = new Set(['zip', '7z']);
  // Backups d'édition audio (`*.original.{ext}`) ignorés silencieusement.
  const filtered = paths.filter((p) => !isOriginalBackup(p));
  return {
    audio: filtered.filter((p) => AUDIO.has(ext(p))),
    images: filtered.filter((p) => IMAGES.has(ext(p))),
    archives: filtered.filter((p) => ARCHIVES.has(ext(p))),
  };
}

// Retourne true si le projet a du contenu (= mérite d'être sauvegardé)
function isProjectDirty(project) {
  if (!project) return false;
  // La question posée ici est « y a-t-il un projet ouvert ? », et elle l'était
  // déjà : l'exception avancée puis le test de type disaient à eux deux
  // exactement ce prédicat. Un projet avancé porte un document d'auteur dès son
  // acquisition et n'a ni arbre ni médias racine à inventorier ; un type
  // hiérarchique choisi vaut projet ouvert de la même façon.
  if (isProjectOpen(project)) return true;
  let hasEntries = false;
  visitProjectEntries(project, (entry) => {
    if (entry.type === 'story' || entry.type === 'zip' || entry.type === 'menu') hasEntries = true;
  });
  return !!project.projectName || !!project.rootAudio || !!project.rootImage || hasEntries;
}

function canonicalMediaLibraryPaths(paths) {
  const byKey = new Map();
  for (const path of Array.isArray(paths) ? paths : []) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = pathKey(path);
    if (!byKey.has(key)) byKey.set(key, path);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key]) => key);
}

function canonicalMediaTags(mediaTags) {
  const tagsByPath = new Map();
  for (const [path, tags] of Object.entries(mediaTags && typeof mediaTags === 'object' ? mediaTags : {})) {
    if (typeof path !== 'string' || !path.trim()) continue;
    const key = pathKey(path);
    const merged = tagsByPath.get(key) ?? new Set();
    for (const tag of Array.isArray(tags) ? tags : []) {
      if (typeof tag === 'string') merged.add(tag);
    }
    tagsByPath.set(key, merged);
  }
  return Object.fromEntries(
    [...tagsByPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, tags]) => [path, [...tags].sort()]),
  );
}

// Le `status` d'une liaison média est un relevé de disque, redérivé par qui
// vient d'y écrire ou par l'audit du shell. Le compter dans la signature
// rendrait un projet « non enregistré » parce qu'un audit a tourné, alors
// qu'aucune valeur d'auteur n'a bougé. Le reste du bloc avancé — payload,
// vue, `assetRef` et chemin de chaque liaison — est du travail persistant.
function advancedWorkBody(project) {
  return {
    ...project,
    authoring: {
      ...project.authoring,
      mediaBindings: readMediaBindings(project)
        .map((binding) => (binding && typeof binding === 'object'
          ? Object.fromEntries(Object.entries(binding).filter(([key]) => key !== 'status'))
          : binding)),
    },
  };
}

// L'ordre des clés n'est pas une valeur d'auteur : le même état, relu d'un
// fichier ici et reconstruit par une sauvegarde là, doit rendre une signature
// identique. Le payload reste une chaîne et traverse sans être analysé.
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

// Signature de l'ensemble du travail persistant. Le catalogue Médias et ses
// tags font partie du document au même titre que l'arbre du projet. En mode
// avancé, le document, son contexte et son identité y entrent par la chaîne du
// payload : une mutation d'auteur, si petite soit-elle, change cette chaîne.
export function createWorkSnapshot(project, mediaLibraryPaths = [], mediaTags = {}) {
  return JSON.stringify({
    project: isAdvancedProject(project) ? canonicalValue(advancedWorkBody(project)) : project,
    mediaLibraryPaths: canonicalMediaLibraryPaths(mediaLibraryPaths),
    mediaTags: canonicalMediaTags(mediaTags),
  });
}

export function isSaveInputStillCurrent(inputAtSaveStart, currentInput) {
  return inputAtSaveStart === currentInput;
}

export function assertProjectCanSaveInPlace(project, savePath) {
  if (savePath && !isProjectOpen(project)) {
    throw new Error('Enregistrement refusé : aucun projet valide n’est ouvert. Le fichier existant a été conservé.');
  }
}

export const SAVE_PUBLICATION = Object.freeze({
  CURRENT: 'current',
  STALE: 'stale',
  REPLACED: 'replaced',
});

// Signature du travail tel qu'il sera **après** publication.
//
// Un résultat ne réinstalle son projet que si l'objet qu'on lui a confié est
// encore celui du store (`projectStillCurrent`) ; le catalogue Médias et ses
// tags, eux, ne sont jamais réinstallés par-dessus une modification survenue
// pendant l'écriture. C'est donc ce mélange — projet publié, catalogue et tags
// courants — qu'il faut comparer à ce qui a été écrit, et non le seul projet.
// Sans lui, un média ajouté au catalogue pendant un Save As disparaissait de la
// signature et le travail restant passait pour enregistré.
export function publishedWorkSnapshot({
  projectStillCurrent = false,
  resultProject = null,
  currentProject = null,
  mediaLibraryPaths = [],
  mediaTags = {},
} = {}) {
  return createWorkSnapshot(
    projectStillCurrent ? resultProject : currentProject,
    mediaLibraryPaths,
    mediaTags,
  );
}

// Ce qu'un résultat de sauvegarde a le droit de réinstaller à son retour.
//
// `replaced` — le projet a été remplacé ou réinitialisé pendant l'attente : le
// résultat ne concerne plus ce travail et ne publie rien, pas même son chemin.
// `stale` — le travail a bougé depuis le départ : le fichier écrit est valide
// et devient le chemin courant, mais ce qui reste en mémoire n'y est pas.
// `current` — la mémoire est exactement ce qui vient d'être écrit.
//
// La comparaison porte sur les **signatures**, jamais sur l'identité des objets
// seule : un enregistrement lancé sur un projet corrigé hors du store (relink)
// écrit bien le travail courant et doit pouvoir le déclarer enregistré, tandis
// qu'un projet inchangé dont le catalogue a bougé ne le peut pas.
export function classifySavePublication({
  replaced = false,
  savedSnapshot = null,
  currentSnapshot = null,
} = {}) {
  if (replaced) return SAVE_PUBLICATION.REPLACED;
  return typeof savedSnapshot === 'string' && savedSnapshot === currentSnapshot
    ? SAVE_PUBLICATION.CURRENT
    : SAVE_PUBLICATION.STALE;
}

// Application du résultat à l'état de travail vivant. Un résultat périmé ne
// réinstalle jamais son projet : il ne remplacerait pas seulement la mutation
// en cours, il la ferait passer pour enregistrée.
export function applySavePublication({
  decision,
  work,
  result,
  savedSnapshot = null,
  projectStillCurrent = false,
  savedSnapshotRef = null,
  autoSaveSnapshotRef = null,
}) {
  if (decision === SAVE_PUBLICATION.REPLACED) return decision;
  if (projectStillCurrent) work.syncProjectWithoutHistory(result.project);
  work.setSavePath(result.path);
  if (decision === SAVE_PUBLICATION.CURRENT) {
    if (savedSnapshotRef) savedSnapshotRef.current = savedSnapshot;
    if (autoSaveSnapshotRef) autoSaveSnapshotRef.current = null;
  }
  return decision;
}

export function hasUnsavedWork({
  project,
  mediaLibraryPaths = [],
  mediaTags = {},
  savedSnapshot = null,
  pristine = false,
} = {}) {
  if (savedSnapshot !== null) {
    return createWorkSnapshot(project, mediaLibraryPaths, mediaTags) !== savedSnapshot;
  }
  // Travail neuf encore dans son état de départ (`isPristineWork`) : rien à
  // perdre tant que la médiathèque et ses étiquettes n'ont rien d'autre. Les
  // médias que le projet référence déjà (le catalogue s'en peuple après
  // l'atterrissage d'un pack importé) ne sont pas du travail de l'auteur.
  if (pristine) {
    const own = new Set(canonicalMediaLibraryPaths(reconcileMediaLibraryPaths(project, [])));
    const extras = canonicalMediaLibraryPaths(mediaLibraryPaths).filter((key) => !own.has(key));
    if (extras.length === 0 && Object.keys(canonicalMediaTags(mediaTags)).length === 0) return false;
  }
  return isProjectDirty(project)
    || canonicalMediaLibraryPaths(mediaLibraryPaths).length > 0
    || Object.keys(canonicalMediaTags(mediaTags)).length > 0;
}

export function hasExplicitExportPackName(project) {
  const metadata = project?.packMetadata ?? {};
  if (metadata.namingMode === 'legacy') return !!String(metadata.legacyExportName || '').trim();
  if (String(metadata.title || '').trim()) return true;
  if (project?.projectType === 'simple') return !!String(project?.projectName || '').trim();
  return false;
}

export function shouldPromptRegenerateImportedUuid(metadata) {
  const current = String(metadata?.uuid || '').trim();
  const original = String(metadata?.originalUuid || '').trim();
  return !!current && !!original && current === original;
}

export function buildTransferPromptSignature(savePath, candidates) {
  return `${pathKey(savePath)}::${candidates.map((candidate) => pathKey(candidate.path)).sort().join('|')}`;
}

export function shouldAbortEphemeralPromotion({ isEphemeralSession = false, transferErrors = [] } = {}) {
  return !!isEphemeralSession && Array.isArray(transferErrors) && transferErrors.length > 0;
}
