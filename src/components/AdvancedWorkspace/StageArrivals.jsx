import { useTranslation } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// Comment on arrive sur un Écran : par les listes de choix où il figure.
//
// Sur la Lunii, on n'arrive jamais sur un Écran sans passer par une liste :
// Écran → liste de choix → Écran. Figurer dans une liste ne suffit pas pour
// autant. Pour chaque liste, le panneau dit **quand** elle amène ici :
//
// - **À l'ouverture** : les Écrans qui ouvrent la liste en commençant sur ce
//   choix (ou au hasard). Un Écran qui l'ouvre sur un autre choix n'amène pas
//   ici à l'ouverture, et il n'est pas nommé.
// - **À la molette** : les choix voisins dont la molette est active. C'est la
//   molette **du voisin** qui mène ici ; celle de cet Écran règle où l'on va
//   en partant, dans l'encadré « Molette ».
//
// Une ligne n'apparaît que si le chemin existe. Quand aucun des deux ne mène
// ici, la liste le dit : c'est la décision que l'auteur a à prendre (régler
// un point de départ, activer une molette).
//
// Ajouter à une liste, c'est ajouter cet Écran à la fin des choix d'une
// liste : le geste même de « Ajouter un choix » dans le panneau de la liste,
// vu depuis l'autre bout. Changer sa place se fait dans la liste.

import { useEffect, useState } from 'react';

import { Button } from '../common/Button';
import { HelpHint } from '../common/HelpHint';
import { Plus } from '../icons/LucideLocal.jsx';
import { NodeLink, NodeThumbnail } from './connectionRows.jsx';
import { NodePicker } from './NodePicker.jsx';
import { advancedGestures, optionTarget } from '../../store/projectModel/advancedGestures.js';

// Au-delà, les Écrans d'arrivée se replient : un menu peut être ouvert par
// 170 Écrans.
const SHOWN_ARRIVALS = 3;

const HOW = { ok: 'graph:arrivals.route.label', home: 'graph:arrivals.home.label' };
const RANDOM_HOW = { ok: 'graph:arrivals.route.random', home: 'graph:arrivals.home.random' };

const WHEEL_HELP = 'graph:arrivals.wheel.help';

function ArrivalLine({ label, help = null, children }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  return (
    <div className="advanced-arrival__line">
      <span className="advanced-arrival__label">
        {label}
        {help && <HelpHint text={help} />}
      </span>
      <div className="advanced-arrival__content">{children}</div>
    </div>
  );
}

function DirectArrivals({ row, thumbnails, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [open, setOpen] = useState(false);
  const shown = open ? row.direct : row.direct.slice(0, SHOWN_ARRIVALS);
  const hidden = row.direct.length - shown.length;
  return (
    <ul className="advanced-arrival__list">
      {shown.map((opener) => (
        <li key={opener.key} className="advanced-arrival__item">
          <NodeThumbnail path={opener.sourcePath} thumbnails={thumbnails} />
          <NodeLink path={opener.sourcePath} label={opener.source.label.label} onFocusPath={onFocusPath} />
          <span className="advanced-arrival__how">
            {opener.random ? t(RANDOM_HOW[opener.slot]) : t(HOW[opener.slot])}
          </span>
        </li>
      ))}
      {hidden > 0 && (
        <li>
          <button type="button" className="advanced-link" onClick={() => setOpen(true)}>
            {t('graph:arrivals.hidden.count', { count: hidden })}
          </button>
        </li>
      )}
    </ul>
  );
}

// Les voisins d'où la molette mène ici : leur molette est active.
function wheelArrivals(row) {
  if (row.count < 2) return [];
  return row.neighbours.filter((neighbour) => neighbour.wheel === true && neighbour.stagePath);
}

function WheelArrivals({ index, active, thumbnails, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  return (
    <ul className="advanced-arrival__list">
      {active.map((neighbour) => (
        <li key={neighbour.key} className="advanced-arrival__item">
          <span className="advanced-arrival__how">{t('graph:arrivals.from.label')}</span>
          <NodeThumbnail path={neighbour.stagePath} thumbnails={thumbnails} />
          <NodeLink path={neighbour.stagePath} label={index?.byPath.get(neighbour.stagePath)?.label?.label ?? neighbour.label} onFocusPath={onFocusPath} />
          <span className="advanced-arrival__how">{t('graph:wheel.choice.label', { ordinal: neighbour.rank + 1 })}</span>
        </li>
      ))}
    </ul>
  );
}

// Seuls les chemins qui existent sont montrés : l'encadré répond à « comment
// arrive-t-on ici ? », pas à ce qui n'y mène pas. La seule absence dite est
// celle qui compte : rien ne mène ici par cette liste.
function ListArrival({ index, row, disabled, thumbnails, onFocusPath, onRemove }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const byWheel = wheelArrivals(row);
  const unreachable = row.direct.length === 0 && byWheel.length === 0;
  return (
    <li className="advanced-arrival">
      <div className="advanced-arrival__head">
        <span className="advanced-arrival__place">{t('graph:arrivals.choice.position', { ordinal: row.rank + 1, total: row.count })}</span>
        <NodeThumbnail path={row.actionPath} thumbnails={thumbnails} nature="action" />
        <NodeLink path={row.actionPath} label={row.action.label.label} onFocusPath={onFocusPath} />
        <Button
          size="sm"
          variant="ghost"
          className="advanced-arrival__remove"
          disabled={disabled}
          onClick={onRemove}
        >{t('graph:arrivals.list.remove')}</Button>
      </div>
      {row.direct.length > 0 && (
        <ArrivalLine label={t('graph:arrivals.open.label')}>
          <DirectArrivals row={row} thumbnails={thumbnails} onFocusPath={onFocusPath} />
        </ArrivalLine>
      )}
      {byWheel.length > 0 && (
        <ArrivalLine label={t('graph:arrivals.wheel.label')} help={t(WHEEL_HELP)}>
          <WheelArrivals index={index} active={byWheel} thumbnails={thumbnails} onFocusPath={onFocusPath} />
        </ArrivalLine>
      )}
      {unreachable && (
        <p className="advanced-field__warning advanced-arrival__warning">{t('graph:arrivals.unreachable.description')}</p>
      )}
    </li>
  );
}

function AddToListForm({ stage, index, disabled, onGesture, onClose }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [actionPath, setActionPath] = useState(null);
  const chosen = actionPath ? index?.byPath.get(actionPath) : null;
  const apply = () => {
    if (!chosen) return;
    const options = chosen.node.options ?? [];
    onGesture(advancedGestures.insertActionOption(
      chosen.node.id,
      options.length,
      optionTarget.stage(stage.uuid),
    ));
    onClose();
  };
  return (
    <div className="advanced-field__form">
      <p className="advanced-field__note">{t('graph:arrivals.add.description')}</p>
      <label htmlFor="advanced-arrival-action">{t('graph:type.action.label')}</label>
      <NodePicker
        id="advanced-arrival-action"
        index={index}
        kind="action"
        value={actionPath}
        onChange={setActionPath}
        disabled={disabled}
      />
      <div className="advanced-field__actions">
        <Button size="sm" onClick={onClose}>{t('common:dialog.cancel.label')}</Button>
        <Button size="sm" variant="primary" disabled={disabled || !chosen} onClick={apply}>{t('graph:arrivals.add.confirm')}</Button>
      </div>
    </div>
  );
}

export function StageArrivals({
  stage, memberships, index, disabled, thumbnails, onGesture, onFocusPath, onRemoveOption, onViewConnections,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setAdding(false);
  }, [stage.path]);

  const isEntry = stage.squareOne?.presence === 'value' && stage.squareOne.value === true;

  return (
    <section className="card advanced-editor__section">
      <div className="advanced-editor__section-heading advanced-editor__section-heading--list">
        <div className="card-title">{t('graph:arrivals.title.label')}</div>
        {onViewConnections && (
          <button type="button" className="advanced-link" onClick={() => onViewConnections(stage.path)}>{t('graph:connections.reveal.label')}</button>
        )}
      </div>

      {isEntry && (
        <p className="advanced-field__note">{t('graph:arrivals.entry.description')}</p>
      )}

      {memberships.length === 0
        ? !isEntry && (
          <p className="advanced-field__warning">{t('graph:arrivals.list.absent')}</p>
        )
        : (
          <ol className="advanced-arrivals">
            {memberships.map((row) => (
              <ListArrival
                index={index}
                key={row.key}
                row={row}
                disabled={disabled}
                thumbnails={thumbnails}
                onFocusPath={onFocusPath}
                onRemove={() => onRemoveOption(row.actionPath, row.rank)}
              />
            ))}
          </ol>
        )}

      {/* L'Écran d'entrée n'est jamais le choix d'une liste. */}
      {!isEntry && (
        <div className="advanced-field__actions">
          <Button size="sm" disabled={disabled} onClick={() => setAdding(true)}>
            <Plus />{t('graph:arrivals.add.open')}</Button>
        </div>
      )}
      {adding && !isEntry && (
        <AddToListForm
          stage={stage}
          index={index}
          disabled={disabled}
          onGesture={onGesture}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}
