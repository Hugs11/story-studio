import { readAuthoringRevision } from '../projectModel/authoringRevision.js';

// L'historique des médias d'un exemple.
//
// L'insertion est une étape d'undo. Les images, puis les audios TTS, arrivent
// après elle par des gestes `set-stage-media` séparés ; chacun ouvrirait sinon
// sa propre étape, et un Ctrl+Z après l'insertion ne retirerait qu'un média.
//
// Règle retenue : un média de l'exemple est installé **sans étape d'undo**
// — il se fond dans l'étape d'insertion — seulement si, depuis le commit de
// l'insertion (ou du dernier média fondu) :
// - l'historique du store n'a pas bougé (même repère `historyMark`, voir
//   `projectStore.readHistoryMark`) : aucune étape posée, annulée ou rétablie,
//   y compris par une écriture hors document comme la Fiche du pack ou le nom
//   du projet, que la révision d'auteur ne voit pas ;
// - le document a encore la révision d'auteur laissée par l'exemple ;
// - aucun rétablissement n'est en attente.
// Un Ctrl+Z restaure alors l'état d'avant l'exemple : structure et médias
// partent ensemble, et un redo rend l'exemple avec les médias déjà arrivés.
//
// Dans tous les autres cas, ou au moindre doute (repère illisible), le média
// qui arrive en retard devient une étape ordinaire, exactement comme un dépôt
// de média : il ne se glisse jamais sous une étape de l'auteur. Un undo
// ultérieur retire d'abord ce média, puis l'étape de l'auteur, puis l'exemple
// (avec les médias fondus avant elle) ; poser cette étape vide la pile de
// rétablissement, comme tout geste. Un média dont l'Écran a disparu (exemple
// annulé) est refusé par le geste lui-même : rien n'est installé et le redo
// de l'exemple reste disponible.
export function createExampleHistory({ readRevision = readAuthoringRevision } = {}) {
  let latest = null;
  return {
    // Ouvre la propriété de l'exemple qui vient d'être commité, avec le repère
    // d'historique lu dans ce commit. Le jeton précédent est abandonné : ses
    // médias tardifs seront des étapes à part.
    claim({ project, historyMark }) {
      latest = { revision: readRevision(project), historyMark };
      return latest;
    },
    // Le prédicat lu par le commit de la session (`intent.history`). Quand il
    // fond le média, il suit la nouvelle révision ; l'historique, lui, ne
    // bouge pas, et le média suivant du même exemple peut encore s'y fondre.
    historyFor(token) {
      return ({ from, to, canRedo = false, historyMark }) => {
        const merge = token !== null && token === latest && !canRedo
          && token.historyMark !== undefined && token.historyMark !== null
          && historyMark === token.historyMark
          && token.revision !== null && readRevision(from) === token.revision;
        if (!merge) return true;
        token.revision = readRevision(to);
        return false;
      };
    },
    release() {
      latest = null;
    },
  };
}
