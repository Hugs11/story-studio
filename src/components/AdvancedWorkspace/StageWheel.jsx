import { useTranslation } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
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
  previous: { text: 'graph:wheel.side.previous', icons: <ChevronLeft /> },
  next: { text: 'graph:wheel.side.next', icons: <ChevronRight /> },
  both: { text: 'graph:wheel.side.both', icons: <><ChevronLeft /><ChevronRight /></> },
};

function Neighbour({ neighbour, index, thumbnails, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  return (
    <li className="advanced-arrival__item">
      <Tooltip text={t(SIDES[neighbour.side].text)}>
        <span className="advanced-wheel__side" role="img" aria-label={t(SIDES[neighbour.side].text)}>
          {SIDES[neighbour.side].icons}
        </span>
      </Tooltip>
      {neighbour.stagePath ? (
        <>
          <NodeThumbnail path={neighbour.stagePath} thumbnails={thumbnails} />
          <NodeLink path={neighbour.stagePath} label={index?.byPath.get(neighbour.stagePath)?.label?.label ?? neighbour.label} onFocusPath={onFocusPath} />
        </>
      ) : <em className="advanced-field__absent">{t('graph:wheel.choice.empty')}</em>}
      <span className="advanced-arrival__how">
        {neighbour.wraps ? t('graph:wheel.choice.wrap', { ordinal: neighbour.rank + 1 }) : t('graph:wheel.choice.label', { ordinal: neighbour.rank + 1 })}
      </span>
    </li>
  );
}

export function StageWheel({ index, stage, memberships, disabled, thumbnails, onGesture, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const wheel = controlValue(stage, 'wheel');
  const scrollable = memberships.some((row) => row.count > 1);

  let body = null;
  if (memberships.length === 0) {
    body = <p className="advanced-field__note">{t('graph:wheel.list.absent')}</p>;
  } else if (wheel === false) {
    body = scrollable
      ? <p className="advanced-field__note">{t('graph:wheel.disabled.description')}</p>
      : null;
  } else {
    body = (
      <>
        <div className="advanced-exit__label">{t('graph:wheel.destination.label')}</div>
        <ol className="advanced-arrivals">
          {memberships.map((row) => (
            <li key={row.key} className="advanced-arrival">
              <div className="advanced-arrival__head">
                <NodeThumbnail path={row.actionPath} thumbnails={thumbnails} nature="action" />
                <NodeLink path={row.actionPath} label={row.action.label.label} onFocusPath={onFocusPath} />
              </div>
              {row.count < 2
                ? <p className="advanced-field__absent">{t('graph:wheel.list.single')}</p>
                : (
                  <ul className="advanced-arrival__list">
                    {row.neighbours.map((neighbour) => (
                      <Neighbour index={index} key={neighbour.key} neighbour={neighbour} thumbnails={thumbnails} onFocusPath={onFocusPath} />
                    ))}
                  </ul>
                )}
            </li>
          ))}
        </ol>
        {memberships.length > 1 && (
          <p className="advanced-field__note">{t('graph:wheel.list.description')}</p>
        )}
      </>
    );
  }

  return (
    <section className="card advanced-editor__section advanced-controls advanced-exit">
      <div className="card-title-row">
        <div className="card-title">{t('graph:controls.wheel.label')}</div>
        <div className="card-copy card-copy--inline">{t('graph:wheel.description.label')}</div>
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
