// La molette d'un Écran, troisième sortie après la suite du parcours et le
// bouton Accueil : activée, elle fait passer aux choix voisins dans la liste
// par laquelle on est arrivé. L'encadré le dit concrètement — quel Écran à
// gauche, quel Écran à droite — au lieu d'une règle abstraite.
//
// La molette boucle, comme sur la Lunii : après le dernier choix vient le
// premier. Un choix encore vide garde sa place, mais la molette ne s'y arrête
// pas.

import { Tooltip } from '../common/Tooltip';
import { ChevronLeft, ChevronRight } from '../icons/LucideLocal.jsx';
import { NodeLink, NodeThumbnail } from './connectionRows.jsx';
import { CONTROL_PHRASES, ControlRow, controlValue } from './ControlsEditor.jsx';

const SIDES = {
  previous: { text: 'à gauche', icons: <ChevronLeft /> },
  next: { text: 'à droite', icons: <ChevronRight /> },
  both: { text: 'des deux côtés', icons: <><ChevronLeft /><ChevronRight /></> },
};

function Neighbour({ neighbour, thumbnails, onFocusPath }) {
  return (
    <li className="advanced-arrival__item">
      <Tooltip text={SIDES[neighbour.side].text}>
        <span className="advanced-wheel__side" role="img" aria-label={SIDES[neighbour.side].text}>
          {SIDES[neighbour.side].icons}
        </span>
      </Tooltip>
      {neighbour.stagePath ? (
        <>
          <NodeThumbnail path={neighbour.stagePath} thumbnails={thumbnails} />
          <NodeLink path={neighbour.stagePath} label={neighbour.label} onFocusPath={onFocusPath} />
        </>
      ) : <em className="advanced-field__absent">choix vide, sauté</em>}
      <span className="advanced-arrival__how">
        choix {neighbour.rank + 1}{neighbour.wraps ? ', on reboucle' : ''}
      </span>
    </li>
  );
}

export function StageWheel({ stage, memberships, disabled, thumbnails, onGesture, onFocusPath }) {
  const wheel = controlValue(stage, 'wheel');
  const scrollable = memberships.some((row) => row.count > 1);

  let body = null;
  if (memberships.length === 0) {
    body = <p className="advanced-field__note">Cet Écran n’est dans aucune liste : la molette n’a rien à faire défiler.</p>;
  } else if (wheel === false) {
    body = scrollable
      ? <p className="advanced-field__note">Sur cet Écran, on ne peut pas passer aux autres choix de la liste.</p>
      : null;
  } else {
    body = (
      <>
        <div className="advanced-exit__label">Fait défiler</div>
        <ol className="advanced-arrivals">
          {memberships.map((row) => (
            <li key={row.key} className="advanced-arrival">
              <div className="advanced-arrival__head">
                <NodeThumbnail path={row.actionPath} thumbnails={thumbnails} nature="action" />
                <NodeLink path={row.actionPath} label={row.action.label.label} onFocusPath={onFocusPath} />
              </div>
              {row.count < 2
                ? <p className="advanced-field__absent">Un seul choix : rien à faire défiler.</p>
                : (
                  <ul className="advanced-arrival__list">
                    {row.neighbours.map((neighbour) => (
                      <Neighbour key={neighbour.key} neighbour={neighbour} thumbnails={thumbnails} onFocusPath={onFocusPath} />
                    ))}
                  </ul>
                )}
            </li>
          ))}
        </ol>
        {memberships.length > 1 && (
          <p className="advanced-field__note">La molette fait défiler la liste par laquelle on est arrivé sur cet Écran.</p>
        )}
      </>
    );
  }

  return (
    <section className="card advanced-editor__section advanced-controls advanced-exit">
      <div className="card-title-row">
        <div className="card-title">Molette</div>
        <div className="card-copy card-copy--inline">Où mène la molette ?</div>
      </div>
      <div className="sequence-controls advanced-controls__toggles">
        <ControlRow
          stage={stage}
          control="wheel"
          label={CONTROL_PHRASES.wheel}
          disabled={disabled}
          onGesture={onGesture}
        />
      </div>
      {body}
    </section>
  );
}
