// Les métadonnées communes aux deux éditeurs : leur source de vérité, ce qui
// est éditable, et ce que la production en fait réellement.
//
// La fiche du pack est unique. Elle s'ouvre donc sur deux documents
// qui ne rangent pas ces valeurs au même endroit :
//
// - côté Libre, elles vivent dans `project.packMetadata`, en clair ;
// - côté graphe, titre, version et description vivent dans le document d'auteur ;
//   l'identité livrée vit dans son contexte opaque, que seul Rust ouvre.
//
// Ce module est la seule table qui dit, champ par champ, qui les gouverne. Il
// existe parce que brancher la fiche sans lui aurait produit exactement la
// faute que le plan du mouvement 1 interdit : un auteur modifiant un titre dans
// une copie que la production ne lit jamais.
//
// **Il ne devine rien.** Un champ que le document de graphe ne porte pas n'est
// pas affiché avec un repli : `minAge` vaut `'3'` par défaut côté Libre parce
// que la convention de nom l'exige, et afficher ce `3` sur un projet graphe en
// ferait une valeur d'auteur qui n'existe pas. De même pour les compteurs : un
// projet graphe n'a pas d'arbre, et compter ses histoires rendrait le zéro
// calculé que le plan nomme explicitement.
//
// Tout est pur : aucun React, aucun Tauri, aucun accès au payload.

import { advancedGestures, presence } from './projectModel/advancedGestures.js';
import { MEDIA_BINDING_RESOLVED, mediaBindingsByAssetRef } from './projectModel/mediaBindings.js';
import { isFallbackProjectName } from './projectSaveName.js';

// Les origines du document, telles que le DTO de lecture les sérialise.
const DOCUMENT_ORIGIN_CREATED = 'created';

// Un titre renseigné reste prioritaire ; les noms de création ne sont pas
// des titres d'auteur. Le repli reste une proposition jusqu'à validation.
export function suggestedPackTitle(project, view = null) {
  const advanced = project?.authoringMode === 'advanced';
  const title = advanced ? presenceValue(view?.metadata?.title) : project?.packMetadata?.title;
  if (String(title ?? '').trim() && String(title).trim().toLowerCase() !== 'nouveau pack') return title;
  const root = advanced ? view?.entryTitle : project?.projectType === 'pack' ? project?.rootName : '';
  const rootText = String(root ?? '').trim();
  if (rootText && !/^(menu racine|écran 1|nouveau pack)$/i.test(rootText)) return rootText;
  return isFallbackProjectName(project?.projectName) ? '' : String(project.projectName).trim();
}

// Les quatre métadonnées que **les deux** structures portent réellement.
export const SHARED_METADATA_FIELDS = Object.freeze(['title', 'version', 'description', 'uuid']);

// Les quatre que la fiche Libre affiche en plus. Elles ne composent que le nom
// du fichier exporté (`generateConventionName`) et n'entrent pas dans le pack ;
// le document de graphe n'a donc pas à les porter, et la fiche ne les invente
// pas de son côté.
export const NAMING_ONLY_FIELDS = Object.freeze(['author', 'minAge', 'producer', 'bonus']);

function presenceValue(field) {
  return field?.presence === 'value' ? field.value : null;
}

/**
 * Ce que la production avancée fera réellement de chaque champ.
 *
 * L'UUID montré est l'identité du pack livré. Une modification explicite dans
 * la fiche change cette identité et la racine du document dans un seul geste.
 * Sans modification, l'identité acquise à la création ou à l'import demeure.
 */
export function advancedFieldGovernance(documentOrigin) {
  void documentOrigin;
  return {
    title: { editable: true, reason: null },
    description: { editable: true, reason: null },
    version: { editable: true, reason: null },
    uuid: { editable: true, reason: null },
  };
}

/**
 * L'identifiant que la production écrira dans le pack, et lui seul.
 *
 * La `packIdentity` gouverne le Stage d'entrée exporté, créé ou importé.
 * La racine `uuid` d'un import peut en différer : elle ne doit pas masquer
 * l'identité réellement utilisée pour installer le pack.
 */
export function advancedProducedIdentity(view) {
  return view?.packIdentity?.value ?? null;
}

/**
 * La lecture de la fiche pour un projet graphe : ce que le formulaire commun
 * affiche, sans repli inventé.
 */
export function advancedPackMetadataDraft(view, project = null) {
  const metadata = view?.metadata ?? null;
  const version = presenceValue(metadata?.version);
  return {
    title: project ? suggestedPackTitle(project, view) : presenceValue(metadata?.title) ?? '',
    description: presenceValue(metadata?.description) ?? '',
    // La version reste vide quand le document n'en porte pas : un document
    // importé sans version explicite est refusé à l'export, et afficher « 1 »
    // masquerait ce refus derrière un repli.
    version: version == null ? '' : String(version),
    uuid: advancedProducedIdentity(view) ?? '',
    originalUuid: advancedImportedIdentity(view),
  };
}

// Les origines d'une identité lue dans le pack repris, et encore inchangée :
// un changement par la fiche la rend `generated`.
const IMPORTED_IDENTITY_ORIGINS = new Set(['square-one-stage', 'fs-entry-stage']);

/**
 * L'identité que le pack repris portait, tant que l'auteur ne l'a pas changée.
 * Vide sinon — document créé, identité tirée faute d'être lisible, ou déjà
 * renouvelée : rien n'est alors « d'origine » à garder ou remplacer.
 */
export function advancedImportedIdentity(view) {
  const identity = view?.packIdentity ?? null;
  return IMPORTED_IDENTITY_ORIGINS.has(identity?.origin) ? (identity?.value ?? '') : '';
}

/**
 * La référence d'image de l'Écran d'entrée, lue dans l'index de la vue.
 * `null` sans Écran d'entrée unique ou sans image : il n'y a alors rien que
 * l'export puisse reprendre comme vignette.
 */
export function advancedEntryImageRef(index) {
  const entries = (index?.entries ?? []).filter((entry) => (
    entry.kind === 'stage' && entry.node?.squareOne?.value === true
  ));
  if (entries.length !== 1) return null;
  const image = entries[0].node?.image;
  return image?.presence === 'value' ? (image.assetRef ?? null) : null;
}

/**
 * La couverture que la fiche d'un projet graphe montre : celle que l'export
 * écrira. La vignette de l'enveloppe gagne ; à défaut, l'export reprend l'image
 * de l'Écran d'entrée, et la fiche la montre aussi.
 */
export function advancedCoverImage(project, entryImageRef) {
  return project?.thumbnailImage || advancedEntryImagePath(project, entryImageRef);
}

/**
 * Le chemin de l'image de l'Écran d'entrée, celle que la vignette reprend
 * quand le projet n'en a pas de propre. `null` si elle n'est pas résolue.
 */
export function advancedEntryImagePath(project, entryImageRef) {
  if (!entryImageRef) return null;
  const binding = mediaBindingsByAssetRef(project).get(entryImageRef);
  return binding?.status === MEDIA_BINDING_RESOLVED ? binding.path : null;
}

/**
 * Les compteurs de pied de fiche pour un projet graphe.
 *
 * Ils comptent ce que la structure a réellement — Écrans, Actions, options et
 * médias liés —, jamais des histoires d'arbre, que ce projet n'a pas.
 */
export function advancedPackMetadataCounters(view, mediaBindings = []) {
  const counts = view?.counts ?? null;
  if (!counts) return null;
  return {
    stages: counts.stages,
    actions: counts.actions,
    options: counts.options,
    media: Array.isArray(mediaBindings) ? mediaBindings.length : 0,
  };
}

function trimmedText(value) {
  return String(value ?? '').trim();
}

/**
 * Les membres du geste, pour les **seuls** champs que l'auteur a réellement
 * changés.
 *
 * Un champ inchangé n'est pas renvoyé : le réécrire remplacerait son absence
 * par une valeur, ou sa valeur par elle-même en créant un pas d'annulation qui
 * ne rend rien. Un champ vidé repart en `absent`, pas en chaîne vide — vider
 * n'est pas renseigner une valeur vide.
 *
 * Rend `null` quand rien n'a bougé : l'appelant n'envoie alors aucun geste.
 */
export function advancedMetadataMembers(view, draft) {
  const governance = advancedFieldGovernance(view?.documentOrigin);
  const metadata = view?.metadata ?? null;
  const members = {};

  function noteText(field, nextRaw) {
    if (!governance[field].editable) return;
    const current = presenceValue(metadata?.[field]);
    const raw = String(nextRaw ?? '');
    // **Le champ inchangé se reconnaît avant tout nettoyage.** Un titre importé
    // « ␣Mon titre␣ » ou une description qui commence par un retour à la ligne
    // sont des valeurs d'auteur : comparer leur version nettoyée à leur version
    // d'origine les déclarait modifiées, et valider la fiche sans y toucher les
    // amputait. C'est la conservation des champs non visés qui l'interdit.
    if (current != null && raw === current) return;
    const next = raw.trim();
    // Une saisie qui ne diffère que par ses extrémités ne vaut pas non plus un
    // geste : elle produirait un pas d'annulation qui ne rend rien.
    if (next === (current ?? '')) return;
    members[field] = next === ''
      ? presence.absent()
      : presence.value(next);
  }

  noteText('title', draft?.title);
  noteText('description', draft?.description);

  if (governance.version.editable) {
    const raw = trimmedText(draft?.version);
    const current = presenceValue(metadata?.version);
    if (raw === '') {
      if (current != null) members.version = presence.absent();
    } else {
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed !== current) {
        members.version = presence.value(parsed);
      }
    }
  }

  if (governance.uuid.editable) {
    const requested = trimmedText(draft?.uuid);
    const current = trimmedText(advancedProducedIdentity(view));
    if (requested !== current) {
      members.packIdentity = requested;
      if (requested) members.uuid = presence.value(requested);
    }
  }

  return Object.keys(members).length === 0 ? null : members;
}

/**
 * Le geste complet, ou `null` s'il n'y a rien à demander.
 */
export function advancedMetadataGesture(view, draft) {
  const members = advancedMetadataMembers(view, draft);
  return members ? advancedGestures.setDocumentMetadata(members) : null;
}

// ── Le récapitulatif du bandeau ──────────────────────────────────────────────
// Une ligne par structure, composée là où l'on sait ce que la structure porte.
// La barre de titre ne la compose plus elle-même : elle repliait l'âge minimum
// sur « 3+ », ce qui aurait affiché une valeur d'auteur inexistante sur un
// projet graphe.

export function freePackRecap(project, projectType) {
  if (!projectType) return null;
  const metadata = project?.packMetadata ?? {};
  const title = metadata.title
    || (projectType === 'simple' ? project?.projectName : '')
    || '';
  return {
    title,
    line: `${metadata.minAge || '3'}+ · v${metadata.version || 1}`,
  };
}

export function advancedPackRecap(view) {
  if (!view) return null;
  const version = presenceValue(view.metadata?.version);
  return {
    title: presenceValue(view.metadata?.title) ?? '',
    // Un document créé sans version en reçoit une à la production — `1`, le
    // défaut ; un document importé sans version explicite y est refusé. Dans les
    // deux cas, afficher « v1 » sans le dire mentirait.
    line: version == null
      ? (view.documentOrigin === DOCUMENT_ORIGIN_CREATED ? 'v1 par défaut à la production' : 'Version non renseignée')
      : `v${version}`,
  };
}

// ── Ce que la fiche fait du résultat de son geste ────────────────────────────
// Appliquer ne ferme pas la fiche par principe : il la ferme quand la demande a
// abouti, ou qu'il n'y avait rien à demander. Dans tous les autres cas — geste
// tenu par un export, geste refusé, session occupée, projet changé sous la
// fiche — la saisie est conservée et la raison est dite. Fermer sans appliquer
// perdrait le texte que l'auteur vient d'écrire, sans qu'aucun message ne le
// prévienne.

export const METADATA_SAVE_CLOSED = 'closed';
export const METADATA_SAVE_KEPT = 'kept';

const SAVE_NOTICES = Object.freeze({
  held: "Un export est en cours. La saisie est conservée ; clique de nouveau sur « Appliquer » une fois l'export terminé.",
  busy: 'Un geste est déjà en cours. Réessaie dans un instant ; la saisie est conservée.',
  queued: 'Un geste est déjà en cours. Réessaie dans un instant ; la saisie est conservée.',
  stale: "Le projet a changé pendant l'application. Vérifie les valeurs avant de réessayer.",
  refused: "La modification a été refusée et rien n'a été écrit. La saisie est conservée.",
});

/**
 * Traduit l'issue d'un geste de métadonnées en décision de fiche.
 *
 * `outcome` est `null` quand aucun geste n'était nécessaire : rien n'a changé,
 * donc rien à appliquer, donc la fiche peut se fermer.
 */
export function metadataSaveDecision(outcome) {
  if (outcome == null || outcome.status === 'applied') {
    return { result: METADATA_SAVE_CLOSED, notice: null };
  }
  return {
    result: METADATA_SAVE_KEPT,
    notice: SAVE_NOTICES[outcome.status]
      ?? "La modification n'a pas été appliquée. La saisie est conservée.",
  };
}
