import { useTranslation } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// Les deux sorties d'un Écran, chacune dans son encadré : la **suite du
// parcours** (`okTransition`) et le **bouton Accueil** (`homeTransition`).
//
// Une sortie se lit comme l'auteur la pense : ce qui la déclenche, puis où
// elle mène. La suite a deux déclencheurs, l'appui sur OK et la fin du son
// (lecture automatique) : ils partagent **une seule** destination, et le
// panneau ne la montre qu'une fois. Accueil n'a qu'un déclencheur, son
// bouton : l'encadré ne pose donc pas la question du déclenchement, il dit si
// le bouton est actif, puis où il ramène.
//
// Déclencheurs et destination sont affichés ensemble mais restent deux gestes
// distincts. Éteindre le dernier déclencheur ne retire pas la destination ; une
// destination enregistrée sans déclencheur actif reste visible, signalée comme
// inutilisée, et n'est jamais masquée.
//
// La destination est une Liste de choix et le choix sur lequel on y
// **commence** : la liste garde son ordre, c'est l'Écran de départ qui dit où
// l'on tombe. Ce point de départ se règle sur place, sans formulaire. Une liste à un seul choix se lit directement « Mène à <Écran> »,
// la liste restant nommée en second.
//
// Retirer une destination est un seul geste pour l'auteur : il pose `null`,
// la forme que STUdio écrit pour une sortie qui ne mène nulle part. La
// différence entre `null` et une donnée absente reste une affaire du format ;
// un pack importé la garde tant que l'auteur n'y touche pas.

import { useEffect, useMemo, useState } from 'react';

import { Button } from '../common/Button';
import { Pencil, Trash2 } from '../icons/LucideLocal.jsx';
import { Tooltip } from '../common/Tooltip.jsx';
import { HelpHint } from '../common/HelpHint';
import { ActionSelectionFields } from './ActionSelectionFields.jsx';
import { LandingSelect, landingGesture } from './LandingSelect.jsx';
import { defaultHomeTarget } from '../../store/advancedGraphView/defaultHomeReturns.js';
import { NodeLink, NodeThumbnail } from './connectionRows.jsx';
import { CONTROL_PHRASES, ControlRow, controlValue } from './ControlsEditor.jsx';
import { NodePicker } from './NodePicker.jsx';
import {
  RANDOM_OPTION_INDEX,
  advancedGestures,
  presence,
} from '../../store/projectModel/advancedGestures.js';

const EXITS = {
  ok: {
    title: 'graph:controls.route.title',
    term: 'okTransition',
    copy: 'graph:destinations.route.copy',
    triggers: ['ok', 'autoplay'],
    triggerLabel: 'graph:destinations.route.trigger',
    triggerHelp: 'graph:destinations.route.help',
    destinationLabel: 'graph:destinations.route.label',
    idle: 'graph:destinations.route.idle',
    unused: 'graph:destinations.route.unused',
    formTitle: 'graph:destinations.route.formTitle',
    formNote: 'graph:destinations.route.formNote',
  },
  home: {
    title: 'graph:controls.home.label',
    term: 'homeTransition',
    copy: 'graph:destinations.home.copy',
    triggers: ['home'],
    triggerLabel: null,
    destinationLabel: 'graph:destinations.home.label',
    // « Bouton Accueil désactivé » se lit sur l'interrupteur : rien à ajouter.
    idle: null,
    unused: 'graph:destinations.home.unused',
    formTitle: 'graph:destinations.home.formTitle',
    formNote: 'graph:destinations.home.formNote',
  },
};

// Le choix sur lequel on commence dans la liste, réglable sur place : changer
// la valeur l'applique aussitôt, comme les interrupteurs de l'encadré.
function ExitLanding({ stage, row, index, disabled, onGesture }) {
  return (
    <LandingSelect
      id={`advanced-landing-${row.slot}`}
      landing={row.landing}
      choices={row.options.map((option) => ({ ...option, label: index?.byPath.get(option.stagePath)?.label?.label ?? option.label }))}
      disabled={disabled}
      onChange={(value) => onGesture(landingGesture(stage.uuid, row.slot, row.action.node.id, value))}
    />
  );
}

// Une liste à un seul choix dont le départ se lit : pour l'auteur, la sortie
// mène directement à cet Écran.
function directStage(row) {
  if (row.options.length !== 1) return null;
  const { landing } = row;
  if (!landing || landing.random || landing.unknown || landing.missing) return null;
  return row.options[0].stagePath ? row.options[0] : null;
}

function DestinationActions({ row, label, disabled, onEdit, onRemove }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const removeLabel = t('graph:destinations.remove.aria', { slot: row.slot === 'ok' ? t('graph:exit.ok.label') : t('graph:exit.home.label') });
  return (
    <div className="advanced-exit__actions">
      <Tooltip text={label} asChild>
        <Button size="sm" variant="icon" disabled={disabled} onClick={onEdit} aria-label={label}>
          <Pencil />
        </Button>
      </Tooltip>
      <Tooltip text={removeLabel} asChild>
        <Button size="sm" variant="icon" disabled={disabled} aria-label={removeLabel} onClick={() => {
          if (disabled) return;
          onRemove();
        }}>
          <Trash2 />
        </Button>
      </Tooltip>
    </div>
  );
}

// La destination enregistrée, sous l'intitulé « Mène à » : la liste, puis le
// choix sur lequel on y commence, réglable sur place. La ligne ne porte aucun
// verbe — c'est l'intitulé qui le porte, pour toutes les formes. Le stylo
// change la liste, la corbeille retire le raccord ; le point de départ se
// règle directement dans la ligne.
function Destination({ stage, row, index, disabled, thumbnails, onGesture, onFocusPath, onEdit, onRemove }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const count = row.options.length;
  const direct = directStage(row);

  if (direct) {
    return (
      <li className="advanced-options__group">
        <div className="advanced-options__row advanced-exit__row">
          <span className="advanced-options__target">
            <NodeThumbnail path={direct.stagePath} thumbnails={thumbnails} />
            <NodeLink path={direct.stagePath} label={index?.byPath.get(direct.stagePath)?.label?.label ?? direct.label} onFocusPath={onFocusPath} />
          </span>
          <DestinationActions row={row} label={t('graph:destinations.change.stage')} disabled={disabled} onEdit={onEdit} onRemove={onRemove} />
        </div>
        <div className="advanced-options__place advanced-options__place--flush">
          <span>{t('graph:destinations.via.label')}</span>
          <NodeLink path={row.actionPath} label={row.action?.label?.label ?? row.actionLabel} onFocusPath={onFocusPath} />
          <span>{t('graph:destinations.single.label')}</span>
        </div>
      </li>
    );
  }

  return (
    <li className="advanced-options__group">
      <div className="advanced-options__row advanced-exit__row">
        <span className="advanced-options__target">
          <NodeThumbnail path={row.actionPath} thumbnails={thumbnails} nature="action" />
          <NodeLink path={row.actionPath} label={row.action?.label?.label ?? row.actionLabel} onFocusPath={onFocusPath} />
          <span className="advanced-count">{t('graph:destinations.choices.count', { count })}</span>
        </span>
        <DestinationActions row={row} label={t('graph:destinations.change.list')} disabled={disabled} onEdit={onEdit} onRemove={onRemove} />
      </div>
      {count === 0 || !row.action
        ? <p className="advanced-field__absent">{t('graph:destinations.empty.label')}</p>
        : <ExitLanding stage={stage} row={row} index={index} disabled={disabled} onGesture={onGesture} />}
    </li>
  );
}

const DEVICE_RETURN_HELP = 'graph:destinations.home.help';

// Accueil sans destination enregistrée : la Lunii et le simulateur reviennent
// à l'Écran d'entrée du pack (`defaultHomeReturns.js`, la même règle que le
// trait dérivé du graphe). Le panneau dit ce comportement réel, et qu'il vient
// de l'appareil, au lieu d'un « ne mène nulle part » qui serait faux.
function HomeFallback({ stage, index, thumbnails, onFocusPath }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const entryPath = defaultHomeTarget(index);
  if (entryPath && entryPath === stage.path) {
    // Le retour par défaut ramènerait ici même : Accueil tournerait en rond,
    // ce que STUdio refuse. Seul un document importé peut arriver ici.
    return (
      <p className="advanced-field__warning">{t('graph:destinations.home.loop')}</p>
    );
  }
  if (!entryPath) {
    return (
      <p className="advanced-field__warning">{t('graph:destinations.home.missing')}</p>
    );
  }
  return (
    <div className="advanced-options__row advanced-options__row--fallback">
      <span className="advanced-options__target">
        <NodeThumbnail path={entryPath} thumbnails={thumbnails} />
        <NodeLink path={entryPath} label={index.byPath.get(entryPath)?.label?.label} onFocusPath={onFocusPath} />
        <span className="advanced-exit__landing-label">
          <HelpHint text={t(DEVICE_RETURN_HELP)} />
          <span className="advanced-options__verb">{t('graph:destinations.home.default')}</span>
        </span>
      </span>
    </div>
  );
}

// Le formulaire d'une sortie, posé dans son encadré. Il part de la liste déjà
// choisie, s'il y en a une.
function ExitForm({ stage, row, index, disabled, onGesture, onClose }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [actionPath, setActionPath] = useState(row.actionPath);
  const initialSelection = row.landing?.random
    ? 'random'
    : String(Number.isInteger(row.landing?.rank) ? row.landing.rank : 0);
  const [selection, setSelection] = useState(initialSelection);
  const chosen = actionPath ? index?.byPath.get(actionPath) : null;
  const options = chosen?.node.options ?? [];
  const exit = EXITS[row.slot];

  const apply = () => {
    if (!chosen) {
      onGesture(advancedGestures.setStageTransition(stage.uuid, row.slot, presence.null()));
    } else {
      onGesture(options.length === 0
        ? advancedGestures.connectStageToEmptyAction(stage.uuid, row.slot, chosen.node.id)
        : advancedGestures.setStageTransition(
          stage.uuid,
          row.slot,
          advancedGestures.transitionTo(
            chosen.node.id,
            options.length === 1 ? 0 : selection === 'random' ? RANDOM_OPTION_INDEX : Number(selection),
          ),
        ));
    }
    onClose();
  };
  const id = `advanced-slot-${row.slot}`;
  return (
    <div className="advanced-field__form">
      <div className="advanced-field__form-title">{t(exit.formTitle)}</div>
      <p className="advanced-field__note">{t(exit.formNote)}</p>
      <label htmlFor={id}>{t('graph:destinations.form.list')}</label>
      <NodePicker
        id={id}
        index={index}
        kind="action"
        value={actionPath}
        onChange={(path) => { setActionPath(path); setSelection('0'); }}
        disabled={disabled}
      />
      {!chosen && (
        <p className="advanced-field__note">
          {row.slot === 'home'
            ? t('graph:destinations.form.homeEmpty')
            : t('graph:destinations.form.routeEmpty')}
        </p>
      )}
      <ActionSelectionFields
        id={`${id}-selection`}
        options={options}
        index={index}
        selection={selection}
        onChange={setSelection}
        disabled={disabled}
      />
      <div className="advanced-field__actions">
        <Button size="sm" onClick={onClose}>{t('common:dialog.cancel.label')}</Button>
        <Button size="sm" variant="primary" disabled={disabled} onClick={apply}>{t('graph:controls.completion.apply')}</Button>
      </div>
    </div>
  );
}

// Un encadré de sortie : ses déclencheurs, puis sa destination.
//
// Quand tous les déclencheurs sont explicitement éteints et qu'aucune
// destination n'est enregistrée, la destination est repliée : il n'y a rien à
// régler. Un déclencheur non défini ne la replie pas — on ne sait pas s'il
// s'active.
function ExitCard({
  stage, row, index, disabled, thumbnails, highlight, editing, onGesture, onFocusPath, onEdit, onClose,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const exit = EXITS[row.slot];
  // Sur l'Écran d'entrée, Accueil n'a rien à faire : l'enfant est déjà au
  // début du pack, et le retour par défaut tournerait en rond. L'encadré ne
  // propose donc pas de l'allumer. Il reste complet pour un document importé
  // qui l'a déjà allumé ou raccordé : l'auteur doit pouvoir le voir et l'éteindre.
  const entryHomeIdle = row.slot === 'home'
    && stage.squareOne?.presence === 'value' && stage.squareOne.value === true
    && controlValue(stage, 'home') !== true
    && row.presence !== 'value' && !editing;
  if (entryHomeIdle) {
    return (
      <section className="card advanced-editor__section advanced-controls advanced-exit" data-highlight={highlight ? 'true' : undefined}>
        <div className="card-title-row">
          <div className="card-title">
            {t(exit.title)} <em className="advanced-editor__term">{exit.term}</em>
          </div>
        </div>
        <p className="advanced-field__note">{t('graph:destinations.home.entryIdle')}</p>
      </section>
    );
  }
  const values = exit.triggers.map((control) => controlValue(stage, control));
  const armed = values.includes(true);
  const undetermined = values.includes(null);
  const wired = row.presence === 'value';
  const showsDestination = armed || undetermined || wired || editing;

  let destination = null;
  if (wired) {
    destination = (
      <ol className="advanced-options">
        <Destination
          stage={stage}
          row={row}
          index={index}
          disabled={disabled}
          thumbnails={thumbnails}
          onGesture={onGesture}
          onFocusPath={onFocusPath}
          onEdit={onEdit}
          onRemove={() => {
            onClose();
            onGesture(advancedGestures.setStageTransition(stage.uuid, row.slot, presence.null()));
          }}
        />
      </ol>
    );
  } else if (row.slot === 'home') {
    destination = <HomeFallback stage={stage} index={index} thumbnails={thumbnails} onFocusPath={onFocusPath} />;
  } else {
    destination = <p className="advanced-field__absent">{t('graph:destinations.route.absent')}</p>;
  }

  return (
    <section className="card advanced-editor__section advanced-controls advanced-exit" data-highlight={highlight ? 'true' : undefined}>
      <div className="card-title-row">
        <div className="card-title">
          {t(exit.title)} <em className="advanced-editor__term">{exit.term}</em>
        </div>
        <div className="card-copy card-copy--inline">{t(exit.copy)}</div>
      </div>

      {exit.triggerLabel && (
        <div className="advanced-exit__label">
          {t(exit.triggerLabel)}
          {exit.triggerHelp && <HelpHint text={t(exit.triggerHelp)} />}
        </div>
      )}
      <div className="sequence-controls advanced-controls__toggles">
        {exit.triggers.map((control) => (
          <ControlRow
            key={control}
            stage={stage}
            control={control}
            label={CONTROL_PHRASES[control]}
            disabled={disabled}
            onGesture={onGesture}
          />
        ))}
      </div>

      {showsDestination ? (
        <>
          <div className="advanced-exit__label">{t(exit.destinationLabel)}</div>
          {destination}
          {wired && !armed && !undetermined && (
            <p className="advanced-field__warning">{t(exit.unused)}</p>
          )}
          {!wired && !editing && (
            <div className="advanced-field__actions">
              <Button size="sm" disabled={disabled} onClick={onEdit}>
                <Pencil /> {row.slot === 'home' ? t('graph:destinations.home.choose') : t('graph:destinations.route.choose')}
              </Button>
            </div>
          )}
        </>
      ) : exit.idle && (
        <p className="advanced-field__note">{t(exit.idle)}</p>
      )}

      {editing && (
        <ExitForm
          key={`${stage.path}:${row.slot}`}
          stage={stage}
          row={row}
          index={index}
          disabled={disabled}
          onGesture={onGesture}
          onClose={onClose}
        />
      )}
    </section>
  );
}

export function StageDestinations({
  stage, rows, index, disabled, thumbnails, highlight = false, onGesture, onFocusPath,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [editing, setEditing] = useState(null);

  // Changer d'Écran ferme le formulaire : un brouillon appartient au nœud sur
  // lequel il a été ouvert, et le transporter ailleurs poserait la valeur d'un
  // écran sur un autre.
  useEffect(() => {
    setEditing(null);
  }, [stage.path]);

  const bySlot = useMemo(() => new Map(rows.map((row) => [row.slot, row])), [rows]);

  return ['ok', 'home'].map((slot) => {
    const row = bySlot.get(slot);
    if (!row) return null;
    return (
      <ExitCard
        key={slot}
        stage={stage}
        row={row}
        index={index}
        disabled={disabled}
        thumbnails={thumbnails}
        highlight={highlight}
        editing={editing === slot}
        onGesture={onGesture}
        onFocusPath={onFocusPath}
        onEdit={() => setEditing(slot)}
        onClose={() => setEditing(null)}
      />
    );
  });
}
