// Le parcours de fabrication du pack, côté éditeur graphe.
//
// Les deux éditeurs traversent désormais les mêmes quatre étapes, dans le même
// ordre : la fiche du pack, ce qui bloque, la destination, puis le départ. Ce
// module tient les deux du milieu.
//
// **La quatrième ne lance pas directement une archive** : elle capture ce qui
// part et dépose un travail dans la file de rendu, qui le sert quand le poste
// natif est libre. Ce module n'en sait rien, et c'est voulu — il décrit l'ordre
// des questions, jamais le lieu du travail.
//
// **Le refus arrive avant l'effort, et avant la destination.** Le tiroir
// d'export proposait « Exporter malgré les blocages » et laissait le moteur
// trancher à l'étape 2 de sa propre chaîne ; l'auteur avait alors déjà choisi
// un dossier pour s'entendre dire non. Poser la question ici ne change **rien**
// à ce qui est vérifié : le moteur refait ses contrôles et reste l'autorité.
// Ce module change où et quand on demande, jamais la règle.
//
// ## Les deux sources, et pourquoi il en faut deux
//
// La liste « à corriger » du Libre pose deux questions : le projet est-il bien
// construit, **et** ses fichiers sont-ils là ? La qualification du graphe ne
// pose que la première — elle est calculée sur le document en mémoire et ne
// touche jamais au disque, par construction.
//
// Les brancher telles quelles aurait laissé passer un projet graphe dont un son
// a été déplacé, pour le faire refuser plus tard par le moteur, après le choix
// du dossier. La seconde question est donc posée ici aussi, à partir du
// **relevé que l'application tient déjà** : l'audit de liaisons requalifie
// chaque média à chaque passage, et c'est lui qui alimente le bandeau de
// reconnexion. Aucune règle n'est inventée ; la même question est posée plus
// tôt.

import { MEDIA_BINDING_MISSING, readMediaBindings } from '../projectModel/mediaBindings.js';
import { EXPORT_REFUSAL, PREPARATION_REFUSAL } from '../advancedExport/exportOutcome.js';

// Forme commune d'un refus, identique à celle que `classifyExportRefusal` rend
// pour un refus venu du moteur : le rapport d'export n'a donc qu'un seul
// branchement à connaître, et un refus précoce se lit exactement comme le refus
// tardif qu'il remplace.
function refusal(fields) {
  return {
    kind: null,
    preparationKind: null,
    title: '',
    message: '',
    code: null,
    cancelled: false,
    residue: false,
    entries: [],
    conflicts: [],
    disagreements: [],
    diagnostics: [],
    integrityErrors: [],
    path: null,
    codecError: null,
    // Le témoin qui distingue ce refus de celui du moteur. Il ne change pas ce
    // qui est affiché ; il dit que rien n'a été appelé, ce que le message porte
    // aussi en toutes lettres.
    beforeEngine: true,
    ...fields,
  };
}

/**
 * Ce qui bloque le document lui-même, ou `null`.
 *
 * `summary` est la qualification rendue par `summarizeReadiness`. Seul son
 * `blocked` décide : c'est la règle du module de qualification, et la recopier
 * autrement créerait un second verdict.
 */
export function documentBlockage(summary) {
  if (summary?.blocked !== true) return null;
  const blocking = Array.isArray(summary.blocking) ? summary.blocking : [];
  return refusal({
    kind: EXPORT_REFUSAL.PREPARATION,
    preparationKind: PREPARATION_REFUSAL.READINESS_BLOCKED,
    title: "Fabrication impossible — qualification d'export bloquée",
    message: "Rien n'a été fabriqué et aucun dossier n'a été demandé : le document porte "
      + `${blocking.length} point(s) à corriger avant de produire le pack.`,
    // Le rapport rend ces lignes telles quelles : chacune porte son niveau, son
    // code, son message et l'emplacement concerné — « ce qui bloque, et où ».
    diagnostics: blocking.map((row) => (
      `${row.levelLabel} · ${row.code}${row.path ? ` · ${row.path}` : ''} — ${row.message}`
    )),
  });
}

/**
 * Un document qui ne référence aucun média, ou `null`.
 *
 * C'est la seule règle que ce module pose lui-même : le moteur accepte un tel
 * pack, mais il ne joue rien et STUdio refuse son archive, faute de dossier
 * `assets/`. On le refuse ici, avant le dossier, plutôt que dans la
 * qualification — celle-ci gouverne aussi la préparation du moteur, et un
 * document d'essai sans média y reste légitime.
 */
export function emptyPackBlockage(referencedAssetRefs) {
  if (!Array.isArray(referencedAssetRefs) || referencedAssetRefs.length > 0) return null;
  return refusal({
    kind: EXPORT_REFUSAL.REQUEST,
    title: 'Fabrication impossible — pack sans média',
    message: 'Le pack ne contient aucun son ni aucune image : ajoute au moins un média '
      + 'à un Écran avant de générer.',
  });
}

/**
 * Les médias employés par le document que le dernier relevé disque donne pour
 * absents, ou `null`. Les anciennes liaisons inutilisées ne concernent pas le
 * pack produit.
 *
 * Une liaison sans chemin n'est pas un fichier perdu : c'est une référence
 * jamais pointée, qui se répare **par sa référence**. Les deux causes sont
 * distinguées, parce que la réparation offerte n'est pas la même.
 */
export function mediaBlockage(project, referencedAssetRefs) {
  if (!Array.isArray(referencedAssetRefs)) {
    throw new TypeError('Les références médias du document doivent être connues avant la production.');
  }
  const entries = [];
  const referenced = new Set(referencedAssetRefs);
  for (const binding of readMediaBindings(project)) {
    if (!binding || typeof binding !== 'object') continue;
    if (!referenced.has(binding.assetRef)) continue;
    const path = typeof binding.path === 'string' ? binding.path.trim() : '';
    if (path.length === 0) {
      entries.push({ assetRef: binding.assetRef, cause: 'path-null', lastKnownPath: null, stageIds: [] });
      continue;
    }
    if (binding.status === MEDIA_BINDING_MISSING) {
      entries.push({ assetRef: binding.assetRef, cause: 'not-found', lastKnownPath: path, stageIds: [] });
    }
  }
  const bound = new Set(readMediaBindings(project).map((binding) => binding?.assetRef));
  for (const assetRef of referenced) {
    if (!bound.has(assetRef)) {
      entries.push({ assetRef, cause: 'binding-absent', lastKnownPath: null, stageIds: [] });
    }
  }
  if (entries.length === 0) return null;
  return refusal({
    kind: EXPORT_REFUSAL.MEDIA_UNAVAILABLE,
    title: 'Fabrication impossible — médias indisponibles',
    message: "Rien n'a été fabriqué et aucun dossier n'a été demandé : les médias utilisés "
      + 'par le pack ci-dessous sont indisponibles.',
    entries,
  });
}

/**
 * Ce qui bloque la fabrication, ou `null` si rien ne bloque.
 *
 * Le document d'abord, les fichiers ensuite : un document illisible rendrait de
 * toute façon l'inventaire des médias sans objet, et c'est aussi l'ordre dans
 * lequel le moteur pose les mêmes questions.
 */
export function advancedProductionBlockage({ readinessSummary, project, referencedAssetRefs }) {
  return documentBlockage(readinessSummary)
    ?? emptyPackBlockage(referencedAssetRefs)
    ?? mediaBlockage(project, referencedAssetRefs);
}

export const ADVANCED_PRODUCTION = Object.freeze({
  REFUSED: 'refused',
  CANCELLED: 'cancelled',
  STARTED: 'started',
});

/**
 * Le voyage complet, des étapes 2 à 4.
 *
 * `assessReadiness` est **rappelée à chaque départ**, jamais lue dans un état
 * mémorisé : une qualification est dérivée du payload courant, et s'en servir
 * périmée reviendrait à refuser — ou à laisser passer — sur la foi d'une
 * révision que l'auteur a quittée.
 */
export async function runAdvancedProduction({
  readProject,
  assessReadiness,
  readReferencedMedia,
  chooseFolder,
  start,
  refuse,
  options,
}) {
  let readinessSummary = null;
  const project = readProject();
  try {
    readinessSummary = await assessReadiness(project);
  } catch (error) {
    // La qualification n'a pas pu être calculée. Ce n'est pas un franchissement :
    // une porte qui n'a pas pu regarder ne dit pas « rien ne bloque ».
    const stopped = refusal({
      kind: EXPORT_REFUSAL.REQUEST,
      title: 'Fabrication impossible',
      message: "La qualification du document n'a pas pu être calculée, et rien n'a été fabriqué : "
        + String(error?.message ?? error),
      code: error?.code ?? null,
    });
    refuse(stopped);
    return { outcome: ADVANCED_PRODUCTION.REFUSED, refusal: stopped };
  }

  let blockage = documentBlockage(readinessSummary);
  if (!blockage) {
    try {
      const referencedAssetRefs = await readReferencedMedia(project);
      blockage = emptyPackBlockage(referencedAssetRefs)
        ?? mediaBlockage(project, referencedAssetRefs);
    } catch (error) {
      blockage = refusal({
        kind: EXPORT_REFUSAL.REQUEST,
        title: 'Fabrication impossible',
        message: "Les médias du document n'ont pas pu être vérifiés, et rien n'a été fabriqué : "
          + String(error?.message ?? error),
        code: error?.code ?? null,
      });
    }
  }
  if (blockage) {
    refuse(blockage);
    return { outcome: ADVANCED_PRODUCTION.REFUSED, refusal: blockage };
  }

  const outputFolder = await chooseFolder();
  if (!outputFolder) return { outcome: ADVANCED_PRODUCTION.CANCELLED };

  const started = await start({ outputFolder, options });
  return { outcome: ADVANCED_PRODUCTION.STARTED, started };
}
