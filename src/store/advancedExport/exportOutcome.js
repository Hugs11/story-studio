// Ce que l'export rend, et ce qu'un refus dit — sans jamais lire une phrase.
//
// Tous les refus de `export_advanced_pack` portent un `kind`, et les refus de
// préparation un second `kind` dans `error`. La règle est de « brancher le
// sous-type, pas une recherche de mots dans le message ». Ce module ne contient
// donc aucune analyse de texte ; `message` et `detail` sont des **données**
// affichées telles quelles.
//
// Deux pièges nommés par le plan sont tenus ici plutôt que dans l'interface,
// pour qu'un test pur puisse les éprouver :
//
// - un `output-write` **reste** un `output-write` même si l'auteur venait de
//   demander l'annulation : le nettoyage d'un `.partial` qui échoue emprunte
//   exactement cette branche, et le présenter comme une simple annulation
//   masquerait un résidu sur le disque ;
// - un dossier créé par le préflight n'est pas une archive publiée. La promesse
//   du writer est l'absence d'archive avant validation, pas l'absence de
//   dossier.

export const EXPORT_REFUSAL = Object.freeze({
  PAYLOAD_DECODE: 'payload-decode',
  PREPARATION: 'preparation',
  MEDIA_UNAVAILABLE: 'media-unavailable',
  ARCHIVE_NAME_COLLISION: 'archive-name-collision',
  MEDIA_ORACLE: 'media-oracle',
  CANCELLED: 'export-cancelled',
  OUTPUT_WRITE: 'output-write',
  // Hors des refus typés : ce qui n'est pas un refus — une rupture de transport,
  // une panique. Il est nommé plutôt que rangé de force dans une des sept
  // familles, parce qu'un diagnostic faux vaut moins qu'un diagnostic absent.
  UNTYPED: 'untyped',
  // Refus **local**, avant tout appel : pas de document d'auteur, pas de
  // dossier choisi. Le moteur n'a rien vu, et le dire évite de laisser croire
  // qu'il a refusé.
  REQUEST: 'request',
});

export const PREPARATION_REFUSAL = Object.freeze({
  GRAPH_INTEGRITY: 'graph-integrity',
  AUTHORING_ACTION_REQUIRED: 'authoring-action-required',
  PACK_IDENTITY: 'pack-identity',
  READINESS_BLOCKED: 'readiness-blocked',
  STANDARD_SERIALIZATION: 'standard-serialization',
});

const REFUSAL_TITLES = Object.freeze({
  [EXPORT_REFUSAL.PAYLOAD_DECODE]: 'Document illisible',
  [EXPORT_REFUSAL.PREPARATION]: 'Préparation refusée',
  [EXPORT_REFUSAL.MEDIA_UNAVAILABLE]: 'Médias indisponibles',
  [EXPORT_REFUSAL.ARCHIVE_NAME_COLLISION]: "Collision de noms dans l'archive",
  [EXPORT_REFUSAL.MEDIA_ORACLE]: 'Rattachement des médias en désaccord',
  [EXPORT_REFUSAL.CANCELLED]: 'Export annulé',
  [EXPORT_REFUSAL.OUTPUT_WRITE]: 'Écriture impossible',
  [EXPORT_REFUSAL.UNTYPED]: 'Export interrompu',
  [EXPORT_REFUSAL.REQUEST]: 'Export impossible',
});

const PREPARATION_TITLES = Object.freeze({
  [PREPARATION_REFUSAL.GRAPH_INTEGRITY]: 'Intégrité du graphe',
  [PREPARATION_REFUSAL.AUTHORING_ACTION_REQUIRED]: "Décision d'auteur requise",
  [PREPARATION_REFUSAL.PACK_IDENTITY]: 'Identité du pack',
  [PREPARATION_REFUSAL.READINESS_BLOCKED]: "Qualification d'export bloquée",
  [PREPARATION_REFUSAL.STANDARD_SERIALIZATION]: 'Sérialisation du document',
});

const MEDIA_CAUSE_LABELS = Object.freeze({
  'binding-absent': 'aucune liaison enregistrée pour cette référence',
  'path-null': 'liaison sans chemin : le fichier doit être choisi par référence',
  'not-found': 'fichier introuvable au chemin enregistré',
  'not-regular': "le chemin ne désigne pas un fichier régulier",
  'read-denied': 'lecture refusée par le système',
  empty: 'fichier vide',
  undecodable: 'contenu non décodable',
  // Un décodage partiel puis échoué emprunte cette cause. Ce n'est pas la
  // preuve que l'auteur a fourni un fichier volontairement invalide.
  'validation-failed': 'le fichier a été rejeté par la validation',
  'tool-unavailable': "l'outil de conversion n'est pas disponible",
  'tool-interrupted': "l'outil de conversion a été interrompu",
  'processing-failed': 'la conversion a échoué',
});

const TRANSFORMATION_LABELS = Object.freeze({
  verbatim: 'copié tel quel',
  renamed: 'renommé pour le paquet',
  reencoded: 'ré-encodé pour le paquet',
  resized: 'redimensionné pour le paquet',
});

const MEDIA_FIELD_LABELS = Object.freeze({ image: 'image', audio: 'audio' });

// `path-null` exige une sélection **par référence** : il n'y a pas d'ancien
// chemin à retrouver. L'interface s'en sert pour offrir la bonne réparation.
export function repairByReferenceOnly(entry) {
  return entry?.cause === 'path-null' || entry?.cause === 'binding-absent';
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

// Le refus, tel qu'il est affichable. `kind` et `preparationKind` sont les deux
// seules valeurs sur lesquelles l'interface se branche.
export function classifyExportRefusal(error) {
  const kind = typeof error?.kind === 'string' ? error.kind : null;
  if (kind === null) {
    return {
      kind: EXPORT_REFUSAL.UNTYPED,
      preparationKind: null,
      title: REFUSAL_TITLES[EXPORT_REFUSAL.UNTYPED],
      // Un refus non typé n'est pas rangé dans `export-cancelled` : l'auteur
      // doit voir qu'il n'a pas reçu de diagnostic contractuel.
      message: typeof error === 'string' ? error : String(error?.message ?? error),
      cancelled: false,
      residue: false,
      entries: [],
      conflicts: [],
      disagreements: [],
      diagnostics: [],
      integrityErrors: [],
      path: null,
      codecError: null,
    };
  }

  const preparationKind = kind === EXPORT_REFUSAL.PREPARATION
    ? (typeof error.error?.kind === 'string' ? error.error.kind : null)
    : null;

  return {
    kind,
    preparationKind,
    title: preparationKind
      ? `${REFUSAL_TITLES[kind] ?? kind} — ${PREPARATION_TITLES[preparationKind] ?? preparationKind}`
      : (REFUSAL_TITLES[kind] ?? kind),
    message: kind === EXPORT_REFUSAL.OUTPUT_WRITE
      ? String(error.message ?? '')
      : String(error.error?.message ?? error.message ?? ''),
    // Seul `export-cancelled` est une annulation. Un `output-write` survenu
    // pendant un abandon reste une panne d'écriture : c'est la branche du
    // nettoyage `.partial`.
    cancelled: kind === EXPORT_REFUSAL.CANCELLED,
    residue: kind === EXPORT_REFUSAL.OUTPUT_WRITE,
    entries: kind === EXPORT_REFUSAL.MEDIA_UNAVAILABLE ? asList(error.entries) : [],
    conflicts: kind === EXPORT_REFUSAL.ARCHIVE_NAME_COLLISION ? asList(error.conflicts) : [],
    disagreements: kind === EXPORT_REFUSAL.MEDIA_ORACLE ? asList(error.disagreements) : [],
    diagnostics: asList(error.error?.diagnostics),
    integrityErrors: asList(error.error?.errors),
    path: kind === EXPORT_REFUSAL.OUTPUT_WRITE ? (error.path ?? null) : null,
    codecError: kind === EXPORT_REFUSAL.PAYLOAD_DECODE ? (error.error ?? null) : null,
  };
}

// Les médias indisponibles, groupés par référence : la même référence peut
// servir plusieurs écrans, et l'auteur répare **une** liaison, pas une par
// écran. Tous les écrans concernés restent listés : la liste est complète,
// pas un échantillon.
export function groupUnavailableMedia(entries) {
  const byRef = new Map();
  for (const entry of asList(entries)) {
    const key = entry?.assetRef ?? '';
    const existing = byRef.get(key);
    if (existing) {
      existing.stageIds = [...new Set([...existing.stageIds, ...asList(entry.stageIds)])];
      existing.fields = [...new Set([...existing.fields, entry.field].filter(Boolean))];
      continue;
    }
    byRef.set(key, {
      assetRef: key,
      fields: [entry?.field].filter(Boolean),
      stageIds: [...asList(entry?.stageIds)],
      lastKnownPath: entry?.lastKnownPath ?? null,
      cause: entry?.cause ?? null,
      causeLabel: MEDIA_CAUSE_LABELS[entry?.cause] ?? entry?.cause ?? 'cause inconnue',
      detail: entry?.detail ?? '',
      byReferenceOnly: repairByReferenceOnly(entry),
    });
  }
  return [...byRef.values()];
}

export function mediaFieldLabel(field) {
  return MEDIA_FIELD_LABELS[field] ?? field ?? 'média';
}

// La relecture porte-t-elle encore sur le document ouvert ?
//
// Deux conditions, et aucune n'est un compteur : l'archive a été produite pour
// **cette** révision — payload et liaisons, jamais le payload seul — et pour
// **ce** travail. Comparer des valeurs est ce qui permet à un undo de rendre
// l'archive courante à nouveau ; un jeton croissant l'interdirait.
//
// Sans révision connue des deux côtés, la réponse est « non » : une relecture
// dont on ne sait pas à quoi elle correspond ne doit pas être présentée comme
// celle du document ouvert.
export function isReviewCurrent(review, current) {
  const produced = review?.revision ?? null;
  const open = current?.revision ?? null;
  if (produced === null || open === null) return false;
  return produced === open && (review.epoch ?? null) === (current.epoch ?? null);
}

// Le succès, tel qu'il est affichable.
//
// Les empreintes (`snapshotSha256`, `outputSha256`, `taskKey`) restent dans les
// lignes brutes, accessibles pour un diagnostic, et **ne sont pas** remontées
// dans le résumé : le plan interdit de les afficher dans le parcours principal.
export function summarizeExportSuccess(result) {
  const conversions = asList(result?.conversions);
  const byTransformation = new Map();
  for (const line of conversions) {
    const key = line?.transformation ?? 'verbatim';
    byTransformation.set(key, (byTransformation.get(key) ?? 0) + 1);
  }
  return {
    zipPath: result?.zipPath ?? null,
    packIdentity: result?.packIdentity ?? null,
    assetCount: conversions.length,
    transformations: [...byTransformation.entries()]
      .map(([transformation, count]) => ({
        transformation,
        count,
        label: TRANSFORMATION_LABELS[transformation] ?? transformation,
      }))
      .sort((left, right) => left.transformation.localeCompare(right.transformation)),
    // Une conversion a eu lieu dès qu'une ligne n'est pas `verbatim`. C'est ce
    // qui déclenche l'explication D-01 : les fichiers de travail restent
    // intacts, et l'harmonisation des volumes est un réglage distinct.
    converted: conversions.some((line) => line?.transformation && line.transformation !== 'verbatim'),
    deduplicated: conversions.filter((line) => line?.deduplicatedWith).length,
    // Les avertissements d'harmonisation ont la forme de ceux de l'éditeur par
    // menus — message et mesures — et se lisent au même endroit. Les autres
    // (un nettoyage de dossier temporaire qui échoue) restent des phrases.
    warnings: [...asList(result?.audioWarnings), ...asList(result?.warnings)],
    // `false` est un succès normal quand l'écran d'entrée n'a pas d'image.
    hasThumbnail: result?.hasThumbnail === true,
    conversions,
    destinations: asList(result?.destinations),
  };
}
