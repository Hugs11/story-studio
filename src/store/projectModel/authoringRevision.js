// La révision d'auteur d'un projet avancé : le document **et** ses liaisons.
//
// Le payload seul ne suffit pas à dire « c'est la même chose ». Remplacer le
// fichier derrière une référence média change le chemin d'une liaison sans
// toucher à la chaîne d'auteur : `assetRef` appartient au payload et le code
// JavaScript ne le réécrit jamais. Deux états que seul un remplacement média
// sépare portent donc le même payload, à l'octet.
//
// Cela a deux conséquences, et ce module les tient toutes les deux :
//
// - une réponse de geste revenue après l'annulation d'un remplacement serait
//   jugée fraîche par le payload seul, et réinstallerait le fichier que
//   l'auteur venait d'écarter (règle de fraîcheur) ;
// - une archive exportée avant ce remplacement serait encore présentée comme
//   celle du document ouvert, alors que ses sons et ses images sont ceux d'avant.
//
// Trois règles portent le fichier :
//
// 1. **Le payload n'est pas ouvert.** La chaîne est prise telle quelle, jamais
//    analysée ni réémise — les entiers opaques du dialecte n'y survivraient
//    pas.
// 2. **`status` n'entre pas dans la révision.** C'est le dernier état connu du
//    disque, redérivé à chaque audit ; le compter ferait périmer un geste
//    parfaitement valide chaque fois qu'un relevé tombe pendant son vol.
// 3. **L'empreinte est injective.** Chaque champ est précédé de sa longueur :
//    aucun couple de valeurs ne peut en imiter un autre par concaténation.

import { readAuthoringPayload } from './authoring.js';
import { readMediaBindings } from './mediaBindings.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Un champ, précédé de sa longueur. `null` a sa propre marque : une liaison
// sans chemin n'est pas une liaison vers la chaîne vide.
function field(value) {
  if (typeof value !== 'string') return '~';
  return `${value.length}:${value}`;
}

// L'empreinte des liaisons d'auteur, dans leur ordre déclaré. L'ordre est
// significatif : c'est celui qui part à `export_advanced_pack`, et le réordonner
// est une mutation du document, pas une variation d'écriture.
function mediaBindingsRevision(bindings) {
  let revision = '';
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    if (!isObject(binding)) continue;
    revision += `${field(binding.assetRef)}${field(binding.path)}|`;
  }
  return revision;
}

// La révision d'une **source d'export** : ce qui part réellement dans la
// demande, pas ce que le projet contenait au moment du clic.
export function authoringRevisionOf({ payload, mediaBindings } = {}) {
  if (typeof payload !== 'string') return null;
  return `${field(payload)}#${mediaBindingsRevision(mediaBindings)}`;
}

// La révision du projet courant. `null` quand il ne porte pas de document
// d'auteur : un projet Libre n'a pas de révision avancée, et lui en inventer
// une ferait comparer deux absences.
export function readAuthoringRevision(project) {
  return authoringRevisionOf({
    payload: readAuthoringPayload(project),
    mediaBindings: readMediaBindings(project),
  });
}
