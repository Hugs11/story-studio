// Les briques des lignes bordées que partagent les panneaux d'Écran et de
// Liste de choix : la vignette d'un nœud, son nom cliquable, la place d'un
// choix dans sa liste, et la phrase qui dit sur quel choix une transition
// arrive.
//
// « Liste de choix » est le nom d'auteur d'une Action : la liste que la
// molette fait défiler. Le modèle, les gestes et le graphe gardent `action`.

import { NodeIcon } from '../icons/NodeIcon.jsx';
import { Tooltip } from '../common/Tooltip';
import { WORKSPACE_MODE_ADVANCED } from '../../store/projectWorkState.js';

// La vignette d'un nœud : l'image d'un Écran quand il en a une, son icône
// sinon. Une Action n'a jamais d'image : elle porte le losange vert d'eau de la
// scène, pour qu'on la reconnaisse dans le panneau comme sur le graphe.
export function NodeThumbnail({ path, thumbnails, nature = 'stage' }) {
  const url = path && nature === 'stage' ? thumbnails.get(path) : null;
  const classes = ['advanced-editor__connection-icon'];
  if (url) classes.push('has-thumbnail');
  if (nature === 'action') classes.push('advanced-editor__connection-icon--action');
  return (
    <span
      className={classes.join(' ')}
      style={url ? { backgroundImage: `url(${url})` } : undefined}
    >
      {!url && <NodeIcon workspaceMode={WORKSPACE_MODE_ADVANCED} nature={nature} />}
    </span>
  );
}

// Le nom d'un nœud, cliquable pour le montrer dans le graphe. Coupé par une
// ellipse, il se lit en entier au survol.
export function NodeLink({ path, label, onFocusPath }) {
  return (
    <Tooltip text={label} asChild whenTruncated>
      <button
        type="button"
        className="advanced-link"
        disabled={!path}
        onClick={() => path && onFocusPath(path, { center: true })}
      >
        {label}
      </button>
    </Tooltip>
  );
}

// La place d'un choix dans sa liste, « 2/14 » : le rang et la taille de la
// liste se lisent ensemble, et « 1/1 » dit qu'une liste à un seul choix reste
// une liste — c'est ainsi que la Lunii enchaîne.
export function positionText(rank, count) {
  return `${rank + 1}/${count}`;
}

// L'intertitre des Écrans qui ouvrent une liste : il répond à « comment
// arrive-t-on sur cette liste ? » par une phrase, avec les mots des sorties
// d'un Écran (`okTransition`, `homeTransition`). « OK » laisserait croire que
// seule la touche compte ; une pastille « Suite » ne se lisait pas.
export const OPENER_SLOT_LABELS = {
  ok: 'Par la suite du parcours de',
  home: 'Par le bouton Accueil de',
};
