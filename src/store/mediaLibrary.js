import { visitProjectEntries, walkProjectMediaReferences } from './projectModel/index.js';
import { mediaBindingLabel, readMediaBindings } from './projectModel/mediaBindings.js';
import { isAdvancedProject } from './projectModel/envelope.js';
import { isOriginalBackup } from '../utils/mediaConventions.js';
import { basename, pathKey, stripWindowsLongPathPrefix } from '../utils/fileUtils.js';
import { mediaTagsFor } from './mediaTags.js';

const EDITED_IMAGE_TAG = 'modifiée';


export function getEditedImageTags(mediaTags, sourcePath) {
  return [...new Set([
    ...mediaTagsFor(mediaTags, sourcePath),
    EDITED_IMAGE_TAG,
  ])];
}

function hasPath(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function extname(path) {
  const file = basename(path);
  const index = file.lastIndexOf('.');
  return index >= 0 ? file.slice(index + 1).toLowerCase() : '';
}

function mediaKind(path) {
  const ext = extname(path);
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) return 'image';
  if (['mp3', 'ogg', 'wav', 'm4a', 'webm', 'flac'].includes(ext)) return 'audio';
  if (['zip', '7z'].includes(ext)) return 'archive';
  return 'other';
}

// 'ai' = ComfyUI/XTTS result · 'recorded' = enregistrements/ · 'imported' = fichiers-importes/ · 'project' = referenced in project node · 'library' = extra standalone path
function detectOrigin(path, source) {
  if (source === 'XTTS' || source === 'ComfyUI') return 'ai';
  const norm = pathKey(path);
  if (norm.includes('/enregistrements/')) return 'recorded';
  if (norm.includes('/fichiers-importes/')) return 'imported';
  if (source === 'Explorateur') return 'library';
  return 'project';
}

function addMedia(map, path, label, source, field, statusByPath = {}, isProjectRef = false, entryId = null, options = {}) {
  if (!hasPath(path)) return;
  // Backups d'édition audio (`*.original.{ext}`) : masqués sauf s'ils sont explicitement
  // référencés par une entrée projet (pour ne jamais rendre invisible une référence existante).
  if (!isProjectRef && !options.allowOriginalBackup && isOriginalBackup(path)) return;
  const checkedPath = stripWindowsLongPathPrefix(path);
  const key = pathKey(checkedPath);
  const existing = map.get(key);
  // `entryId` désigne un nœud d'arbre, `nodePath` un nœud de graphe. Les deux
  // servent la même chose — révéler l'usage — et ne coexistent jamais sur un
  // même projet.
  const usage = {
    label, source, field,
    ...(entryId ? { entryId } : {}),
    ...(options.nodePath ? { nodePath: options.nodePath } : {}),
  };
  if (existing) {
    // Le catalogue durable indique seulement que Story Studio connaît le fichier.
    // Ce n'est pas un usage supplémentaire et il ne doit donc pas gonfler les badges.
    if (options.catalogOnly) return;
    if (options.usageKnown === false) existing.usageKnown = false;
    // Une déclaration sans usage : le projet nomme le fichier, aucun écran ne
    // l'emploie ici. Elle protège le média de la suppression sans gonfler les
    // badges, ce qu'un usage inventé ferait.
    if (options.declaredOnly) {
      existing.inProject = true;
      return;
    }
    existing.usages.push(usage);
    existing.usedCount = existing.usages.length;
    if (isProjectRef) {
      existing.inProject = true;
      existing.projectUsedCount += 1;
    }
    return;
  }
  const declared = options.catalogOnly || options.declaredOnly;
  map.set(key, {
    id: key,
    path,
    name: basename(path),
    kind: mediaKind(path),
    ext: extname(path),
    source,
    field,
    origin: detectOrigin(path, source),
    usages: declared ? [] : [usage],
    usedCount: declared ? 0 : 1,
    projectUsedCount: !declared && isProjectRef ? 1 : 0,
    inProject: isProjectRef,
    exists: statusByPath[path] !== false && statusByPath[checkedPath] !== false,
    // « Sait-on où ce média est employé ? » est une question distincte de « y
    // est-il employé ? ». Vraie partout où l'inventaire des usages est complet
    // par construction ; fausse pour un projet graphe dont la vue n'a pas
    // encore été lue.
    usageKnown: options.usageKnown !== false,
  });
}

function collectProjectMediaPaths(project) {
  const paths = [];
  const seen = new Set();
  for (const reference of walkProjectMediaReferences(project)) {
    if (!hasPath(reference?.path)) continue;
    const key = pathKey(reference.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    paths.push(reference.path);
  }
  return paths;
}

export function mergeMediaLibraryPaths(...pathGroups) {
  const paths = [];
  const seen = new Set();
  for (const group of pathGroups) {
    for (const path of group ?? []) {
      if (!hasPath(path)) continue;
      const key = pathKey(path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    }
  }
  return paths;
}

export function reconcileMediaLibraryPaths(project, mediaLibraryPaths = []) {
  return mergeMediaLibraryPaths(mediaLibraryPaths, collectProjectMediaPaths(project));
}

// Le libellé d'un usage de graphe : le nom de l'Écran, puis le champ qu'il
// occupe. « Écran » sans nom retombe sur son chemin d'auteur, que l'index rend
// déjà tel quel — on ne fabrique pas un nom qui n'existe pas.
function advancedUsageLabel(usage) {
  const field = usage?.field === 'audio' ? 'audio' : usage?.field === 'image' ? 'image' : 'média';
  return `${usage?.label || usage?.nodePath || 'Écran'} · ${field}`;
}

// Une référence que le document cite mais qu'aucun fichier ne résout. Elle n'a
// pas de chemin — c'est précisément son état —, donc pas de clé de chemin : sa
// clé est bâtie sur la référence elle-même, recopiée telle quelle parce qu'elle
// est un jeton opaque et non un chemin. La masquer laisserait croire que le
// document n'en porte pas.
function addUnboundAdvancedRef(map, entry) {
  const assetRef = typeof entry?.assetRef === 'string' ? entry.assetRef : '';
  if (assetRef === '') return;
  const key = `advanced-ref:${assetRef}`;
  if (map.has(key)) return;
  const usages = (entry.usages ?? []).map((usage) => ({
    label: advancedUsageLabel(usage),
    source: 'Document avancé',
    field: usage?.field ?? 'mediaBinding',
    ...(usage?.nodePath ? { nodePath: usage.nodePath } : {}),
  }));
  map.set(key, {
    id: key,
    path: '',
    name: assetRef,
    kind: mediaKind(assetRef),
    ext: extname(assetRef),
    source: 'Document avancé',
    field: 'mediaBinding',
    origin: 'project',
    usages,
    usedCount: usages.length,
    projectUsedCount: usages.length,
    inProject: true,
    // Aucun fichier n'est lié : ce n'est pas « introuvable sur le disque », c'est
    // « sans liaison ». `unbound` sépare les deux, que `exists: false` seul
    // confondrait.
    exists: false,
    usageKnown: true,
    unbound: true,
  });
}

// Mode Avancé : le catalogue ne voit que les liaisons déclarées et les usages
// que la vue du graphe a rendus, jamais le payload d'auteur. Sans cette branche,
// un média encore lié passerait pour inutilisé et `executeMediaDeletion`
// autoriserait sa suppression disque.
//
// Trois états, et ils sont distincts :
//
// - usages **non calculés** (la vue n'a pas été lue) : la liaison protège le
//   média, et l'inventaire des écrans est déclaré absent ;
// - usages calculés et **vides** : la liaison existe, le document ne la cite
//   plus. Ce zéro-là est un fait ;
// - usages calculés et **non vides** : un usage par Écran et par champ, avec le
//   nom de l'Écran.
function addAdvancedMedia(map, project, statusByPath, advancedUsages) {
  // La branche entière est fermée à un projet Libre, y compris si une liste
  // d'usages traîne encore — elle vient d'un éditeur qui vient d'être quitté,
  // et elle ferait apparaître des lignes fantômes dans la médiathèque du Libre.
  if (!isAdvancedProject(project)) return;
  const bindings = readMediaBindings(project);
  const known = Array.isArray(advancedUsages);
  if (bindings.length === 0 && !known) return;

  const usagesByAssetRef = new Map();
  if (known) {
    for (const entry of advancedUsages) {
      if (typeof entry?.assetRef === 'string') usagesByAssetRef.set(entry.assetRef, entry.usages ?? []);
    }
  }

  const boundWithPath = new Set();
  for (const binding of bindings) {
    const assetRef = typeof binding?.assetRef === 'string' ? binding.assetRef : null;
    if (!hasPath(binding?.path)) continue;
    if (assetRef !== null) boundWithPath.add(assetRef);
    const label = mediaBindingLabel(binding);
    if (!known) {
      addMedia(map, binding.path, label, 'Document avancé', 'mediaBinding', statusByPath, true, null, {
        declaredOnly: true,
        usageKnown: false,
      });
      continue;
    }
    const usages = usagesByAssetRef.get(assetRef) ?? [];
    if (usages.length === 0) {
      addMedia(map, binding.path, label, 'Document avancé', 'mediaBinding', statusByPath, true, null, {
        declaredOnly: true,
      });
      continue;
    }
    for (const usage of usages) {
      addMedia(
        map, binding.path, advancedUsageLabel(usage), 'Document avancé',
        usage?.field ?? 'mediaBinding', statusByPath, true, null,
        { nodePath: usage?.nodePath ?? null },
      );
    }
  }

  if (!known) return;
  for (const entry of advancedUsages) {
    if (boundWithPath.has(entry?.assetRef)) continue;
    addUnboundAdvancedRef(map, entry);
  }
}

// Le projet retient-il ce média ? `inProject` est la réponse autoritaire — il
// dit que le document le nomme —, et le compte d'usages n'en est que le détail.
// Les deux surfaces qui refusent une suppression doivent poser la **même**
// question : le dialogue ne peut pas proposer un retrait que l'exécution
// refusera ensuite en silence, ce qui arrivait dès que le compte était à zéro
// sans que la liaison le soit.
export function isMediaHeldByProject(item) {
  return !!item && (item.inProject === true || item.projectUsedCount > 0);
}

export async function executeMediaDeletion({
  item,
  deleteFromDisk = false,
  deleteDisk,
  commitRemoval,
}) {
  if (!item?.path) {
    return { removed: false, blocked: false, diskDeleted: false, diskError: null };
  }
  if (isMediaHeldByProject(item)) {
    return {
      removed: false,
      blocked: true,
      diskDeleted: false,
      diskError: null,
      usedCount: item.projectUsedCount || 1,
    };
  }

  if (deleteFromDisk) {
    try {
      await deleteDisk?.();
    } catch (error) {
      const message = typeof error === 'string' ? error : (error?.message || String(error));
      return { removed: false, blocked: false, diskDeleted: false, diskError: message };
    }
  }

  commitRemoval?.();
  return {
    removed: true,
    blocked: false,
    diskDeleted: deleteFromDisk,
    diskError: null,
  };
}

// `advancedUsages` vient de `describeAdvancedMediaUsages` : la liste, par
// référence d'asset, des Écrans et des champs qui l'emploient. `null` — la
// valeur par défaut — veut dire **non calculé**, jamais « aucun usage ». Un
// projet Libre ne la fournit pas et n'en a pas besoin : ses usages se lisent
// dans l'arbre, que ce module parcourt lui-même.
export function collectMediaLibrary({
  project,
  statusByPath = {},
  sdJobs = [],
  xttsJobs = [],
  extraPaths = [],
  advancedUsages = null,
}) {
  const map = new Map();
  addMedia(map, project?.rootAudio, 'Accueil', 'Projet', 'rootAudio', statusByPath, true);
  addMedia(map, project?.rootImage, 'Accueil', 'Projet', 'rootImage', statusByPath, true);
  addMedia(map, project?.thumbnailImage, 'Bibliothèque', 'Projet', 'thumbnailImage', statusByPath, true);
  addMedia(map, project?.nightModeAudio, 'Mode nuit', 'Projet', 'nightModeAudio', statusByPath, true);

  const addGraph = (graph, scope) => {
    for (const stage of graph?.document?.stageNodes ?? []) {
      const label = `${scope} · ${stage.name || stage.uuid || 'Stage natif'}`;
      addMedia(map, stage.audio, label, 'Graphe natif', 'audio', statusByPath, true);
      addMedia(map, stage.image, label, 'Graphe natif', 'image', statusByPath, true);
    }
  };
  addGraph(project?.nativeGraph, 'Racine');

  addAdvancedMedia(map, project, statusByPath, advancedUsages);

  visitProjectEntries(project, (entry) => {
    const label = entry?.name || (entry?.type === 'menu' ? 'Menu sans titre' : entry?.type === 'zip' ? 'Archive importée' : 'Histoire sans titre');
    const eid = entry?.id || null;
    addMedia(map, entry?.audio, label, entry?.type || 'Projet', 'audio', statusByPath, true, eid);
    addMedia(map, entry?.image, label, entry?.type || 'Projet', 'image', statusByPath, true, eid);
    addMedia(map, entry?.itemAudio, label, 'Titre histoire', 'itemAudio', statusByPath, true, eid);
    addMedia(map, entry?.itemImage, label, 'Titre histoire', 'itemImage', statusByPath, true, eid);
    addMedia(map, entry?.zipPath, label, 'Archive', 'zipPath', statusByPath, true, eid);
    addMedia(map, entry?.afterPlaybackPromptAudio, label, 'Fin histoire', 'afterPlaybackPromptAudio', statusByPath, true, eid);
    addGraph(entry?.nativeGraph, label);
    for (const step of entry?.afterPlaybackSequence ?? []) {
      addMedia(map, step.audio, `${label} · ${step.name || 'Étape de fin'}`, 'Fin histoire', 'audio', statusByPath, true, eid);
      addMedia(map, step.image, `${label} · ${step.name || 'Étape de fin'}`, 'Fin histoire', 'image', statusByPath, true, eid);
    }
    addMedia(map, entry?.afterPlaybackHomeStep?.audio, `${label} · Home`, 'Fin histoire', 'audio', statusByPath, true, eid);
    addMedia(map, entry?.afterPlaybackHomeStep?.image, `${label} · Home`, 'Fin histoire', 'image', statusByPath, true, eid);
  });

  for (const job of xttsJobs) {
    if (job?.status === 'done' && hasPath(job.resultPath)) {
      addMedia(map, job.resultPath, job.targetLabel || job.label || 'Voix générée', 'XTTS', 'audio', statusByPath, false);
    }
  }
  for (const job of sdJobs) {
    for (const path of job?.resultPaths ?? []) {
      addMedia(map, path, job.workflowName || 'Image générée', 'ComfyUI', 'image', statusByPath, false);
    }
  }
  for (const path of extraPaths) {
    addMedia(map, path, 'Bibliothèque média', 'Explorateur', 'library', statusByPath, false, null, {
      allowOriginalBackup: true,
      catalogOnly: true,
    });
  }

  return [...map.values()].sort((a, b) => {
    const kindOrder = { image: 0, audio: 1, archive: 2, other: 3 };
    return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9)
      || a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' });
  });
}
