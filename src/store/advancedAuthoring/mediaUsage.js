// La jointure des deux moitiés d'un média avancé.
//
// Le DTO de lecture porte les **références** et leurs usages (`MediaRefView`) ;
// il ne porte ni chemin disque, ni octets, ni vignette. Le chemin et le statut
// vivent dans `project.authoring.mediaBindings`, que JavaScript possède déjà.
// La jointure se fait par `assetRef`, exactement, et nulle part ailleurs :
// deux références ne fusionnent jamais parce que leurs fichiers portent le même
// nom, et une référence sans liaison reste visible plutôt que d'être omise.
//
// C'est cette jointure qui permet à l'interface de tenir la distinction que le
// plan exige : **cet écran** (une occurrence) et **tous les usages de cette
// référence** (le geste global). Les deux sont montrés avant le geste, jamais
// découverts après.

import {
  MEDIA_BINDING_MISSING,
  mediaBindingsByAssetRef,
  readMediaBindings,
} from '../projectModel/mediaBindings.js';

export function buildMediaUsageIndex(project, view) {
  const bindings = mediaBindingsByAssetRef(project);
  const byAssetRef = new Map();
  for (const media of view?.mediaRefs ?? []) {
    // Le moteur n'inventorie pas les champs vides comme des fichiers à fournir.
    if (typeof media.assetRef !== 'string' || !media.assetRef.trim()) continue;
    const binding = bindings.get(media.assetRef) ?? null;
    byAssetRef.set(media.assetRef, {
      assetRef: media.assetRef,
      usages: media.usages ?? [],
      path: binding?.path ?? null,
      // Une référence citée par le document mais absente des liaisons n'est
      // pas « résolue par défaut » : elle est sans liaison, ce qui est un état
      // distinct d'un fichier manquant et se dit comme tel.
      status: binding ? binding.status : null,
      bound: binding !== null,
      missing: binding !== null && binding.status === MEDIA_BINDING_MISSING,
    });
  }
  // Une liaison que le document ne cite plus reste connue : elle n'est pas
  // effacée du projet, et la masquer laisserait croire qu'elle l'a été.
  for (const [assetRef, binding] of bindings) {
    if (byAssetRef.has(assetRef)) continue;
    byAssetRef.set(assetRef, {
      assetRef,
      usages: [],
      path: binding.path ?? null,
      status: binding.status ?? null,
      bound: true,
      missing: binding.status === MEDIA_BINDING_MISSING,
      unreferenced: true,
    });
  }
  return byAssetRef;
}

// Les références qu'aucun fichier ne résout aujourd'hui, dans l'ordre du DTO.
export function missingMediaRefs(usageIndex) {
  return [...usageIndex.values()].filter((entry) => !entry.unreferenced && (entry.missing || !entry.bound));
}

// Les Écrans qui citent une référence, libellés pour l'affichage.
//
// Plus aucun geste d'auteur ne porte sur l'ensemble des usages : remplacer un
// média est toujours local à son Écran. Cette liste ne sert donc plus à
// prévenir avant un geste global, mais à nommer les usages dans la
// médiathèque — un Écran et un champ, jamais une référence brute.
function usageLabels(index, entry) {
  return (entry?.usages ?? []).map((usage) => ({
    nodePath: usage.nodePath,
    field: usage.field,
    label: index?.byPath.get(usage.nodePath)?.label?.label ?? usage.nodePath,
  }));
}

// Ce que la médiathèque commune a besoin de savoir d'un média avancé, et
// qu'elle ne peut pas calculer elle-même.
//
// La médiathèque parcourt l'arbre pour dresser ses usages. Un projet graphe n'a
// pas d'arbre : ses usages sont dans le DTO, que seule la session de vue
// possède, et les noms d'Écrans dans l'index qui l'accompagne. C'est donc
// l'espace graphe qui prépare cette liste et la remonte ; la médiathèque la
// reçoit ou ne la reçoit pas.
//
// **`null` n'est pas une liste vide.** Une vue absente — l'éditeur n'a pas
// encore lu son document — veut dire « non calculé », pas « aucun usage ». La
// médiathèque s'en sert pour afficher une absence au lieu d'un zéro, et le zéro
// qu'elle affiche est alors un zéro réellement calculé : une liaison que le
// document ne cite plus.
export function describeAdvancedMediaUsages(view, index = null) {
  if (!view) return null;
  return (view.mediaRefs ?? []).map((media) => ({
    assetRef: media.assetRef,
    usages: usageLabels(index, media),
  }));
}

// « Ce fichier est-il employé par le document d'auteur ? », posée sur des
// chemins disque et non sur des références. C'est la question des deux files :
// une voix ou une image générée vient d'être écrite quelque part, et la file
// dit si le projet s'en sert.
//
// La liste des liaisons est **complète** — Rust les produit depuis les
// références réelles du document —, donc « aucune liaison sur ce chemin » est
// un fait, pas une ignorance : `bound: false` se dit « non utilisé » sans
// mentir. Ce qui peut manquer, c'est le **détail** : quels Écrans. D'où les
// deux drapeaux séparés.
export function advancedMediaUsageForPaths(project, advancedUsages, paths, samePath) {
  const candidates = (paths ?? []).filter((path) => typeof path === 'string' && path.length > 0);
  if (candidates.length === 0) return null;
  const bindings = readMediaBindings(project);
  if (bindings.length === 0) return null;

  const matched = bindings.filter((binding) => (
    typeof binding?.path === 'string'
    && candidates.some((candidate) => samePath(binding.path, candidate))
  ));
  if (matched.length === 0) return { bound: false, known: true, usages: [] };

  if (!Array.isArray(advancedUsages)) return { bound: true, known: false, usages: [] };
  const byAssetRef = new Map(advancedUsages.map((entry) => [entry.assetRef, entry.usages ?? []]));
  const usages = [];
  for (const binding of matched) {
    for (const usage of byAssetRef.get(binding.assetRef) ?? []) usages.push(usage);
  }
  return { bound: true, known: true, usages };
}
