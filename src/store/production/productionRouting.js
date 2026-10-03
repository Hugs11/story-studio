// Un seul bouton de production, et la chaîne qu'il emprunte.
//
// Un pack produit par Story Studio va sur le même appareil quel que soit
// l'éditeur qui l'a fabriqué : une seule intention — fabriquer le pack — donc
// une seule commande, plutôt qu'un « Générer le pack » côté Libre et un
// « Exporter le pack… » côté graphe.
//
// Ce module ne fait qu'une chose : dire **quelle chaîne** sert le projet
// ouvert, et appeler son départ. Il ne connaît ni la validation du Libre, ni la
// qualification de l'avancé, ni le verrou natif, ni les dossiers de sortie.
// C'est délibéré : il règle le **chemin d'accès**, jamais une porte, une règle
// ou un refus ; les portes restent celles de chaque chaîne.
//
// Conséquence directe, et c'est elle qui se vérifie : ce qui part au moteur est
// exactement ce que la chaîne ferait partir sans ce module.
//
// **Le voyage est unifié, pas seulement le bouton.** Ce module achemine vers la
// chaîne du projet ouvert, et ignore tout des portes et des refus.
// `startAdvanced` reçoit la fiche du pack, comme côté Libre. Les trois étapes
// suivantes vivent dans `advancedProduction.js`.

import {
  WORKSPACE_MODE_ADVANCED,
  WORKSPACE_MODE_HIERARCHICAL,
} from '../projectWorkState.js';

export const PRODUCTION_CHAIN = Object.freeze({
  FREE: 'free',
  ADVANCED: 'advanced',
});

/**
 * La chaîne qui sert cet éditeur, ou `null` sans projet ouvert.
 *
 * L'accueil n'a pas de barre et donc pas de bouton ; rendre une chaîne par
 * défaut y ferait partir une production sans projet.
 */
export function productionChain(workspaceMode) {
  if (workspaceMode === WORKSPACE_MODE_ADVANCED) return PRODUCTION_CHAIN.ADVANCED;
  if (workspaceMode === WORKSPACE_MODE_HIERARCHICAL) return PRODUCTION_CHAIN.FREE;
  return null;
}

/**
 * La commande de production, **une seule**, pour le bouton comme pour le
 * raccourci.
 *
 * Les deux surfaces appellent cette fonction et aucune autre : c'est ce qui
 * garantit qu'elles ne peuvent pas diverger. Le raccourci ne répond que si
 * l'inventaire de la barre annonce la commande disponible, et cette
 * disponibilité vient elle aussi d'un seul endroit.
 *
 * `startFree` reçoit ce que l'appelant lui passe — l'événement du clic pour le
 * bouton, rien pour le clavier — parce que la chaîne Libre accepte un projet
 * explicite en premier argument et sait déjà distinguer les deux.
 */
export function createProductionCommand({ readWorkspaceMode, startFree, startAdvanced }) {
  return function produce(...args) {
    switch (productionChain(readWorkspaceMode())) {
      case PRODUCTION_CHAIN.ADVANCED:
        return startAdvanced();
      case PRODUCTION_CHAIN.FREE:
        return startFree(...args);
      default:
        return undefined;
    }
  };
}
