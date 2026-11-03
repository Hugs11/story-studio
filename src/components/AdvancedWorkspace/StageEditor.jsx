import { useTranslation } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// L'éditeur d'un Écran : ce que MVP-A permet d'y changer, et rien de plus.
//
// Le nom d'un Écran est modifié par le geste natif `set-node-name` : le champ
// reste donc fidèle au document et ne maintient aucune copie locale durable.
//
// L'identifiant technique reste consultable à côté du nom lisible, et c'est
// aussi lui que les gestes adressent.

import { useMemo } from 'react';

import { Tooltip } from '../common/Tooltip';
import { Trash2 } from '../icons/LucideLocal.jsx';
import { useAdvancedNodeThumbnails } from '../AdvancedGraphCanvas/useAdvancedNodeThumbnails.js';
import {
  CONTROL_PHRASES, ControlRow, ControlsCompletion,
} from './ControlsEditor.jsx';
import { MediaSlotEditor } from './MediaSlotEditor.jsx';
import { StageArrivals } from './StageArrivals.jsx';
import { StageDestinations } from './StageDestinations.jsx';
import { StageWheel } from './StageWheel.jsx';
import {
  describeStageDestinations,
  describeStageMemberships,
} from '../../store/advancedAuthoring/stageProvenance.js';
import { NodeNameEditor } from './NodeNameEditor.jsx';

export function StageEditor({
  inspected,
  project,
  index,
  usage,
  disabled,
  highlightControls,
  onGesture,
  onAssignMedia = null,
  projectEpoch = null,
  onDelete,
  onRemoveOption,
  onFocusPath,
  focusName = false,
  onNameFocusHandled = null,
  onViewConnections,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const stage = inspected.node;
  const isEntry = stage.squareOne?.presence === 'value' && stage.squareOne.value === true;
  const destinations = useMemo(
    () => describeStageDestinations(index, inspected.path),
    [index, inspected.path],
  );
  const memberships = useMemo(
    () => describeStageMemberships(index, inspected.path),
    [index, inspected.path],
  );
  // Les vignettes des Écrans nommés dans les encadrés, une fois chacun :
  // Écrans lancés par les sorties, Écrans qui arrivent ici, voisins de molette.
  const thumbnailEntries = useMemo(() => {
    const entries = new Map();
    const add = (path) => {
      const entry = path ? index?.byPath.get(path) : null;
      if (entry) entries.set(path, entry);
    };
    destinations.forEach((row) => row.options.forEach((option) => add(option.stagePath)));
    memberships.forEach((row) => {
      row.direct.forEach((opener) => add(opener.sourcePath));
      row.neighbours.forEach((neighbour) => add(neighbour.stagePath));
    });
    return [...entries.values()];
  }, [index, destinations, memberships]);
  const thumbnails = useAdvancedNodeThumbnails(project, thumbnailEntries);

  return (
    <div className="advanced-editor">
      <section className="card advanced-editor__identity-card">
      <header className="advanced-editor__header">
        <span className="advanced-editor__kind advanced-editor__kind--stage">{t('graph:type.stage.label')}</span>
        <h2 className="advanced-editor__title">
          {inspected.label.label}
          {inspected.label.isFallback && (
            <Tooltip text={t('graph:stage.name.fallbackHelp')} asChild>
              <em className="advanced-editor__fallback">
                {' '}{t('graph:stage.name.fallback')}</em>
            </Tooltip>
          )}
        </h2>
        {isEntry && (
          <Tooltip text={t('graph:stage.entry.help')} asChild>
            <span className="advanced-editor__badge">{t('graph:stage.entry.label')}</span>
          </Tooltip>
        )}
        {/* L'identifiant, discret à côté du nom : sélectionnable, jamais une
            section à déplier. */}
        <Tooltip text={t('graph:stage.id.label')} asChild>
          <code className="advanced-editor__identifier">
            {inspected.identifier}
            {stage.occurrence > 0 && t('graph:stage.id.occurrence', { ordinal: stage.occurrence })}
          </code>
        </Tooltip>
      </header>

      <div className="field-row advanced-editor__name-row">
        <span className="field-label">{t('graph:name.field.aria')}</span>
        <div className="advanced-editor__name-control">
          <NodeNameEditor
            kind="stage"
            node={stage}
            disabled={disabled}
            focusRequested={focusName}
            onFocusHandled={onNameFocusHandled}
            onGesture={onGesture}
          />
        </div>
      </div>
      </section>

      <section className="card advanced-editor__media-card">
        <div className="card-title-row">
          <div className="card-title">{t('graph:stage.media.title')}</div>
          <div className="card-copy card-copy--inline">{t('graph:stage.media.description')}</div>
        </div>

        {/* La vignette catalogue se choisit dans la fiche du pack : l'Écran
            d'entrée n'a que son image Lunii et son son. */}
        <div className="media-split">
          <div className="media-split-left">
            <div className="media-col-header">{t('graph:stage.media.image')}</div>
            <MediaSlotEditor stage={stage} field="image" usage={usage} disabled={disabled} onGesture={onGesture} onAssignMedia={onAssignMedia} projectEpoch={projectEpoch} />
          </div>
          <div className="media-split-divider" />
          <div className="media-split-right">
            <div className="media-col-header">{t('graph:stage.media.audio')}</div>
            <MediaSlotEditor stage={stage} field="audio" usage={usage} disabled={disabled} onGesture={onGesture} onAssignMedia={onAssignMedia} projectEpoch={projectEpoch} />
          </div>
        </div>
      </section>

      {/* Les boutons non définis bloquent la génération : l'encadré n'existe
          que dans ce cas, avant les réglages qu'il débloque. */}
      <ControlsCompletion
        key={stage.path}
        stage={stage}
        disabled={disabled}
        onGesture={onGesture}
        highlight={highlightControls}
      />

      {/* Les deux sorties de l'Écran, chacune avec ses déclencheurs : la
          suite du parcours, puis le bouton Accueil. */}
      <StageDestinations
        stage={stage}
        rows={destinations}
        index={index}
        disabled={disabled}
        thumbnails={thumbnails}
        highlight={highlightControls}
        onGesture={onGesture}
        onFocusPath={onFocusPath}
      />

      {/* La troisième sortie : les choix voisins de la liste. */}
      <StageWheel
        index={index}
        stage={stage}
        memberships={memberships}
        disabled={disabled}
        thumbnails={thumbnails}
        onGesture={onGesture}
        onFocusPath={onFocusPath}
      />

      <section className="card advanced-editor__section advanced-controls">
        <div className="card-title-row">
          <div className="card-title">{t('graph:controls.pause.title')}</div>
        </div>
        <div className="sequence-controls advanced-controls__toggles">
          <ControlRow
            stage={stage}
            control="pause"
            label={CONTROL_PHRASES.pause}
            disabled={disabled}
            onGesture={onGesture}
          />
        </div>
      </section>

      {/* Les listes de choix par lesquelles on arrive ici : à leur ouverture, ou
          à la molette d'un voisin. */}
      <StageArrivals
        stage={stage}
        memberships={memberships}
        index={index}
        disabled={disabled}
        thumbnails={thumbnails}
        onGesture={onGesture}
        onFocusPath={onFocusPath}
        onRemoveOption={onRemoveOption}
        onViewConnections={onViewConnections}
      />

      <details className="advanced-editor__technical">
        <summary>{t('graph:stage.technical.title')}</summary>
      <section className="advanced-editor__section">
        <h3>{t('graph:stage.layout.title')}</h3>
        <dl className="advanced-editor__identity">
          {/* Un nœud n'a qu'une position, celle du graphe à plat. */}
          <dt>{t('graph:stage.layout.position')}</dt>
          <dd>{Math.round(stage.layout.x)}, {Math.round(stage.layout.y)}</dd>
        </dl>
      </section>
      </details>

      {/* La racine n'a aucun geste de suppression : l'encadré n'y apparaît pas. */}
      {!isEntry && (
        <div className="card card--danger card--danger-compact">
          <div className="card-danger-row">
            <button
              className="card-danger-trash"
              type="button"
              disabled={disabled}
              onClick={onDelete}
              aria-label={t('graph:stage.remove.label')}
            >
              <Trash2 className="card-danger-icon" />
            </button>
            <span className="card-danger-title">{t('graph:stage.remove.label')}</span>
            <p className="card-danger-desc">{t('graph:stage.remove.description')}</p>
          </div>
        </div>
      )}
    </div>
  );
}
