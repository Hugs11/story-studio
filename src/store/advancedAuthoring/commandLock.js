// Le verrou d'auteur posé sur les **commandes**, pas sur les boutons.
//
// Pendant un export, le document est celui qu'on est en train d'écrire : la
// session d'édition refuse les mutations (`held`), et la barre avancée désactive
// Annuler, Rétablir, Enregistrer, Enregistrer sous, Accueil et Ouvrir. Mais la
// barre n'est qu'une des portes. Les mêmes commandes arrivent aussi par le
// clavier, par la garde de fermeture de la fenêtre et par les transitions de
// projet — et celles-là ne consultaient rien. Désactiver un bouton n'est donc
// pas une politique ; porter le verrou dans la commande en est une.
//
// Deux limites sont volontaires :
//
// - **la vue reste libre.** Panoramique, zoom, sélection, recherche, replis,
//   diagnostics et relecture ne mutent pas le document ; les tenir ferait du
//   verrou d'auteur un verrou d'écran, ce que le plan refuse explicitement.
// - **l'annulation de l'export reste atteignable.** C'est la seule sortie que
//   l'auteur a pendant l'écriture de l'archive.
//
// Une commande refusée rend `null`, jamais un succès muet : la garde de
// fermeture lit ce `null` comme « la sauvegarde n'a pas abouti » et garde la
// fenêtre ouverte, plutôt que d'emporter le travail en cours d'écriture.

export const AUTHOR_LOCKED_COMMANDS = Object.freeze([
  'undo',
  'redo',
  'save',
  'saveAs',
  'newProject',
  'openProject',
  'openPack',
  'openRecentProject',
]);

export function isAuthorLockedCommand(name) {
  return AUTHOR_LOCKED_COMMANDS.includes(name);
}

/**
 * Enveloppe une table de commandes. Les noms hors liste passent tels quels :
 * ce module ne décide pas de ce qui existe, seulement de ce qui est tenu.
 *
 * `isLocked` est une **fonction**, relue à chaque appel. Une valeur capturée
 * laisserait passer la frappe arrivée entre la prise du verrou et le rendu
 * suivant.
 */
export function lockAuthorCommands(commands, isLocked, onRefused = () => {}) {
  const guarded = {};
  for (const [name, handler] of Object.entries(commands ?? {})) {
    if (typeof handler !== 'function' || !isAuthorLockedCommand(name)) {
      guarded[name] = handler;
      continue;
    }
    guarded[name] = (...args) => {
      if (isLocked()) {
        onRefused(name);
        return null;
      }
      return handler(...args);
    };
  }
  return guarded;
}
