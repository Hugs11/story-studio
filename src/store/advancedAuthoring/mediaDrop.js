// Traduction d'un dépôt de média vers le geste d'auteur qui lui correspond.
//
// Côté Libre, déposer un son sur une histoire écrit directement le champ de
// l'arbre. Côté graphe, la même intention passe par `set-stage-media` : un
// geste, **une** étape d'annulation, et le remplacement atomique du document
// par la session d'édition. Ce module ne mute rien, ne touche pas au disque et
// n'ouvre pas le payload : il rend la demande que la session enverra, ou la
// raison du refus.
//
// La règle de partage est celle du Libre, transposée telle quelle. Dans
// l'arbre, deux histoires qui portent le même fichier portent le même chemin :
// un seul fichier, et une reliaison les déplace ensemble. Dans le dialecte, ce
// « même fichier » s'écrit **une référence partagée**, pas deux références
// liées au même chemin. Le plan cherche donc d'abord une liaison existante sur
// ce chemin, et ne crée une référence neuve que si aucune ne le porte —
// exactement ce que `bind_created_media` distingue : un emplacement fourni
// exige une référence encore libre, une référence déjà liée se partage sans
// chemin.

import { basename, pathKey } from '../../utils/fileUtils.js';
import { STAGE_KIND } from '../advancedGraphView/graphViewModel.js';
import { advancedGestures, ADVANCED_MEDIA_FIELDS } from '../projectModel/advancedGestures.js';
import { readMediaBindings } from '../projectModel/mediaBindings.js';

// Les natures de média que la médiathèque sait déposer, et le champ d'Écran qui
// leur correspond. Le dialecte n'en porte pas d'autre : un ZIP ou un texte
// déposé sur un Écran n'a nulle part où aller, et se refuse au lieu de choisir.
const FIELD_BY_KIND = Object.freeze({ audio: 'audio', image: 'image' });

export function advancedMediaField(kind) {
  const field = FIELD_BY_KIND[kind] ?? null;
  return field && ADVANCED_MEDIA_FIELDS.includes(field) ? field : null;
}

// Ce qu'un point du canvas désigne, pour un média d'une nature donnée.
//
// Deux refus, et ils ne sont pas des précautions : le vide du canvas ne désigne
// rien, et une **Action** ne porte ni audio ni image — le dialecte ne lui en
// donne pas. Les deux se voient **avant** le relâchement : le fantôme de
// glisser ne nomme aucune cible, et rien ne part.
export function resolveGraphDropTarget({ index, path, kind }) {
  if (!advancedMediaField(kind) || !path) return null;
  const entry = index?.byPath.get(path);
  if (!entry || entry.kind !== STAGE_KIND) return null;
  return { path, uuid: entry.node.uuid, label: entry.label?.label ?? path };
}

// La liaison qui porte déjà ce fichier, comparée par `pathKey` — la même règle
// de comparaison que la médiathèque et que l'audit des chemins, pour qu'un
// antislash Windows et une barre oblique ne fassent pas deux fichiers.
export function boundAssetRefForPath(project, path) {
  const wanted = pathKey(path);
  if (!wanted) return null;
  for (const binding of readMediaBindings(project)) {
    if (typeof binding?.assetRef !== 'string' || !binding.assetRef) continue;
    if (typeof binding.path === 'string' && pathKey(binding.path) === wanted) return binding.assetRef;
  }
  return null;
}

// Une référence encore libre, dérivée du nom du fichier.
//
// Le suffixe n'est pas un détail d'affichage : Rust refuse `ASSET_REF_ALREADY_BOUND`
// si l'on fournit un emplacement pour une référence déjà liée. Sans ce
// désambiguïsateur, deux fichiers **différents** portant le même nom de base —
// deux `voix.flac` dans deux dossiers — rendaient le second dépôt impossible.
//
// `reserved` porte les références déjà promises par le même geste, que le
// projet ne connaît pas encore : un collage qui crée plusieurs liaisons ne doit
// pas donner deux fois le même nom à deux fichiers différents.
export function freeAssetRef(project, path, reserved = []) {
  const taken = new Set([
    ...readMediaBindings(project)
      .map((binding) => binding?.assetRef)
      .filter((assetRef) => typeof assetRef === 'string' && assetRef.length > 0),
    ...reserved,
  ]);
  const candidate = basename(path) || 'media';
  if (!taken.has(candidate)) return candidate;
  const dot = candidate.lastIndexOf('.');
  const stem = dot > 0 ? candidate.slice(0, dot) : candidate;
  const extension = dot > 0 ? candidate.slice(dot) : '';
  for (let suffix = 2; ; suffix += 1) {
    const next = `${stem}-${suffix}${extension}`;
    if (!taken.has(next)) return next;
  }
}

// Le geste qu'un dépôt — ou un choix de fichier depuis l'éditeur d'un Écran —
// produit sur un emplacement média.
//
// `path` est le chemin **final** : la copie dans l'espace de travail, quand la
// préférence la demande, a déjà eu lieu. Ce module ne la déclenche pas, parce
// qu'il ne doit pas savoir qu'un disque existe.
export function planStageMediaAssignment({ project, stageUuid, kind, path }) {
  const field = advancedMediaField(kind);
  if (!field) {
    return { ok: false, code: 'unsupported-kind', reason: 'Un Écran ne porte qu’un audio et une image.' };
  }
  if (typeof stageUuid !== 'string' || stageUuid.length === 0) {
    return { ok: false, code: 'no-stage', reason: 'Aucun Écran désigné.' };
  }
  if (typeof path !== 'string' || path.trim().length === 0) {
    return { ok: false, code: 'no-path', reason: 'Aucun fichier à déposer.' };
  }

  const shared = boundAssetRefForPath(project, path);
  const update = shared
    // Référence déjà liée : elle se partage **sans chemin**. Fournir le chemin
    // serait la re-pointer, ce qui changerait le fichier de tous ses Écrans.
    ? advancedGestures.stageMedia(shared)
    : advancedGestures.stageMedia(freeAssetRef(project, path), { path, present: true });

  return {
    ok: true,
    shared: shared !== null,
    field,
    gesture: advancedGestures.setStageMedia(stageUuid, field, update),
  };
}
