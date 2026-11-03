import { presentUserMessage } from '../../i18n/userMessage.js';
import { translateChecker } from '../../i18n/checkerPresentation.js';
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
  OUTPUT_IDENTITY: 'output-identity',
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

// Tables de clés, résolues à chaque lecture : un refus déjà classé suit la
// langue active (rapport ou popover resté ouvert).
const REFUSAL_TITLES = Object.freeze({
  [EXPORT_REFUSAL.PAYLOAD_DECODE]: 'checker:refusal.title.decode',
  [EXPORT_REFUSAL.OUTPUT_IDENTITY]: 'checker:refusal.title.preparation',
  [EXPORT_REFUSAL.PREPARATION]: 'checker:refusal.title.preparation',
  [EXPORT_REFUSAL.MEDIA_UNAVAILABLE]: 'checker:refusal.title.media',
  [EXPORT_REFUSAL.ARCHIVE_NAME_COLLISION]: 'checker:refusal.title.collision',
  [EXPORT_REFUSAL.MEDIA_ORACLE]: 'checker:refusal.title.oracle',
  [EXPORT_REFUSAL.CANCELLED]: 'checker:refusal.title.cancelled',
  [EXPORT_REFUSAL.OUTPUT_WRITE]: 'checker:refusal.title.write',
  [EXPORT_REFUSAL.UNTYPED]: 'checker:refusal.title.untyped',
  [EXPORT_REFUSAL.REQUEST]: 'checker:refusal.title.request',
});

const PREPARATION_TITLES = Object.freeze({
  [PREPARATION_REFUSAL.GRAPH_INTEGRITY]: 'checker:refusal.preparation.integrity',
  [PREPARATION_REFUSAL.AUTHORING_ACTION_REQUIRED]: 'checker:refusal.preparation.author',
  [PREPARATION_REFUSAL.PACK_IDENTITY]: 'checker:refusal.preparation.identity',
  [PREPARATION_REFUSAL.READINESS_BLOCKED]: 'checker:refusal.preparation.readiness',
  [PREPARATION_REFUSAL.STANDARD_SERIALIZATION]: 'checker:refusal.preparation.serialization',
});

const MEDIA_CAUSE_LABELS = Object.freeze({
  'binding-absent': 'checker:media.cause.bindingAbsent',
  'path-null': 'checker:media.cause.pathNull',
  'not-found': 'checker:media.cause.notFound',
  'not-regular': 'checker:media.cause.notRegular',
  'read-denied': 'checker:media.cause.readDenied',
  empty: 'checker:media.cause.empty',
  undecodable: 'checker:media.cause.undecodable',
  // Un décodage partiel puis échoué emprunte cette cause. Ce n'est pas la
  // preuve que l'auteur a fourni un fichier volontairement invalide.
  'validation-failed': 'checker:media.cause.validationFailed',
  'tool-unavailable': 'checker:media.cause.toolUnavailable',
  'tool-interrupted': 'checker:media.cause.toolInterrupted',
  'processing-failed': 'checker:media.cause.processingFailed',
});

const TRANSFORMATION_LABELS = Object.freeze({
  verbatim: 'checker:media.transformation.verbatim',
  renamed: 'checker:media.transformation.renamed',
  reencoded: 'checker:media.transformation.reencoded',
  resized: 'checker:media.transformation.resized',
});

const MEDIA_FIELD_LABELS = Object.freeze({ image: 'checker:media.field.image', audio: 'checker:media.field.audio' });

// Valeur inconnue d'une table fermée : la donnée brute reste affichée.
function label(table, value, fallback = value) {
  return Object.hasOwn(table, value ?? '') ? translateChecker(table[value]) : fallback;
}

function refusalTitle(kind, preparationKind) {
  const title = label(REFUSAL_TITLES, kind);
  return preparationKind
    ? translateChecker('production:native.title.qualified', { title, qualification: label(PREPARATION_TITLES, preparationKind) })
    : title;
}

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
      get title() { return refusalTitle(EXPORT_REFUSAL.UNTYPED, null); },
      // Un refus non typé n'est pas rangé dans `export-cancelled` : l'auteur
      // doit voir qu'il n'a pas reçu de diagnostic contractuel.
      get message() { return presentUserMessage(error).message; },
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
    get title() { return refusalTitle(kind, preparationKind); },
    get message() {
      return kind === EXPORT_REFUSAL.OUTPUT_WRITE
        ? presentUserMessage(error.message ?? '').message
        : presentUserMessage(error.error?.message ?? error.message ?? '').message;
    },
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
    const cause = entry?.cause ?? null;
    byRef.set(key, {
      assetRef: key,
      fields: [entry?.field].filter(Boolean),
      stageIds: [...asList(entry?.stageIds)],
      lastKnownPath: entry?.lastKnownPath ?? null,
      cause,
      get causeLabel() { return label(MEDIA_CAUSE_LABELS, cause, cause ?? translateChecker('checker:media.cause.unknown')); },
      detail: entry?.detail ?? '',
      byReferenceOnly: repairByReferenceOnly(entry),
    });
  }
  return [...byRef.values()];
}

export function mediaFieldLabel(field) {
  return label(MEDIA_FIELD_LABELS, field, field ?? translateChecker('checker:media.field.fallback'));
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
        get label() { return label(TRANSFORMATION_LABELS, transformation); },
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
