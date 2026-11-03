import { useTranslation } from 'react-i18next';
import { graphTranslationEngine, translateGraph as t } from '../../i18n/graphPresentation.js';
// L'Inspecteur d'une sélection de plusieurs nœuds du graphe : ce qui se fait
// d'un coup sur tous, comme la sélection multiple du Libre (`MultiEditor`).
//
// - **Générer à partir des noms** : une image-titre et un audio titre par
//   Écran nommé. Un Écran sans nom est laissé de côté — son identifiant n'est
//   pas un titre — et le panneau dit combien. Une Action ne porte aucun média.
// - **Boutons des Écrans** : un bouton basculé pour tous les Écrans, en un
//   seul geste, rangé comme dans le panneau d'un Écran (suite du parcours,
//   bouton Accueil, pause, molette). Les destinations, elles, se règlent
//   Écran par Écran. Un bouton réglé différemment d'un Écran à l'autre s'affiche
//   « mixte ». Un Écran dont les boutons n'ont jamais été définis est laissé
//   de côté, et le panneau le dit : les définir est un choix explicite des
//   cinq valeurs, qui se fait Écran par Écran.
// - **Couleur** : un seul geste pour toute la sélection, comme le clic droit.
// - **Retirer** : la même confirmation que la touche Suppr.
//
// Les médias passent par la même porte qu'un Écran seul (`onAssignMedia`) :
// l'image, dès qu'elle est produite ; l'audio, quand la file de génération le
// rend, par la cible `advancedStage` gardée par l'époque du projet.

import { useState } from 'react';

import { NodeColorPicker } from '../tree/NodeColorPicker.jsx';
import { Toggle } from '../common/Toggle';
import { GroupedControls } from './ControlsEditor.jsx';
import { generateTextImage } from '../TextImageGenerator/generateTextImage';
import { useErrorDialog } from '../common/Dialog';
import { Sparkles, Speech, Trash2 } from '../icons/LucideLocal';
import { useProjectContext } from '../../store/ProjectContext';
import { STAGE_KIND, isEntryStage } from '../../store/advancedGraphView/graphViewModel.js';
import { batchTitleVoice, isTtsAvailable } from '../../store/xttsSettings';


// L'état d'un bouton sur plusieurs Écrans : allumé partout, éteint partout,
// ou mixte — y compris quand un Écran le laisse indéfini.
export function sharedControlState(stages, control) {
  const values = new Set(stages.map((entry) => {
    const member = entry.node.controls?.[control];
    return member?.presence === 'value' ? member.value === true : 'undefined';
  }));
  if (values.size === 1 && values.has(true)) return 'on';
  if (values.size === 1 && values.has(false)) return 'off';
  return 'mixed';
}

// Le titre d'un Écran : son nom d'auteur, jamais un repli.
function stageTitle(entry) {
  return entry.label?.isFallback === false ? entry.label.label.trim() : '';
}

export function GraphSelectionEditor({
  entries,
  disabled = false,
  projectEpoch = null,
  onSetColor,
  onSetControls,
  onAssignMedia,
  onDelete,
}) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const {
    xttsSettings,
    onQueueXttsGenerate,
    onMediaCreated,
    savePath,
    workspaceDir,
    mediaStorage,
  } = useProjectContext();
  const { showErrorDialog } = useErrorDialog();
  const [imagesBusy, setImagesBusy] = useState(false);
  const [audiosBusy, setAudiosBusy] = useState(false);
  const [batchError, setBatchError] = useState([]);

  const paths = entries.map((entry) => entry.path);
  const stages = entries.filter((entry) => entry.kind === STAGE_KIND);
  const actionCount = entries.length - stages.length;
  const titled = stages.filter((entry) => stageTitle(entry) !== '');
  const untitledCount = stages.length - titled.length;
  const batchBusy = imagesBusy || audiosBusy;
  const withControls = stages.filter((entry) => entry.node.controls?.presence === 'value');
  const withoutControlsCount = stages.length - withControls.length;

  const parts = [];
  if (stages.length > 0) parts.push(t('graph:selection.stages.count', { count: stages.length }));
  if (actionCount > 0) parts.push(t('graph:selection.actions.count', { count: actionCount }));

  const colors = [...new Set(entries.map((entry) => entry.node?.personalColor ?? null))];
  const currentColor = colors.length === 1 ? colors[0] : '__mixed__';

  async function generateImages() {
    if (batchBusy || disabled) return;
    setBatchError([]);
    setImagesBusy(true);
    const errors = [];
    try {
      for (const entry of titled) {
        const title = stageTitle(entry);
        try {
          const imagePath = await generateTextImage(title, workspaceDir, { mediaStorage });
          if (!imagePath) continue;
          onMediaCreated?.(imagePath);
          await onAssignMedia(entry.node.uuid, 'image', imagePath);
        } catch {
          errors.push({ key: 'graph:selection.error.image', params: { name: title } });
        }
      }
    } finally {
      setImagesBusy(false);
      if (errors.length > 0) setBatchError(errors);
    }
  }

  async function generateAudios() {
    if (batchBusy || disabled) return;
    setBatchError([]);
    const voice = batchTitleVoice(xttsSettings);
    if (!voice) {
      const message = { key: 'graph:selection.error.voice' };
      setBatchError([message]);
      showErrorDialog({ get title() { return t('graph:selection.error.title'); }, get message() { return t('graph:selection.error.voice'); }, variant: 'warning' });
      return;
    }
    setAudiosBusy(true);
    const errors = [];
    try {
      for (const entry of titled) {
        const title = stageTitle(entry);
        const stageUuid = entry.node.uuid;
        try {
          await onQueueXttsGenerate?.({
            target: {
              kind: 'advancedStage',
              projectEpoch,
              apply: (path) => onAssignMedia(stageUuid, 'audio', path),
            },
            targetLabelRef: { key: 'graph:selection.audio.target', params: { name: title } },
            voiceLabel: voice,
            request: {
              text: title,
              language: xttsSettings?.language || 'fr',
              speaker: null,
              voice,
              savePath,
              filenameHint: `ecran-${stageUuid}`,
            },
          });
        } catch {
          errors.push({ key: 'graph:selection.error.audio', params: { name: title } });
        }
      }
    } finally {
      setAudiosBusy(false);
      if (errors.length > 0) setBatchError(errors);
    }
  }

  const canGenerateAudio = isTtsAvailable(xttsSettings);

  return (
    <div className="advanced-selection-editor">
      <div className="advanced-selection-editor__banner">
        {t('graph:selection.banner.count', { count: entries.length, selection: parts.length === 2 ? t('graph:selection.counts.list', { stages: parts[0], actions: parts[1] }) : parts[0] ?? '' })}
      </div>

      {stages.length > 0 && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">{t('graph:selection.generate.title')}</div>
          </div>
          <div className="editor-setting-row is-action-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">{t('graph:selection.generate.label')}</div>
              <div className="editor-setting-desc">
                {titled.length > 0
                  ? t('graph:selection.generate.description', { count: titled.length })
                  : t('graph:selection.generate.empty')}
                {untitledCount > 0 && titled.length > 0
                  && t('graph:selection.generate.ignored', { count: untitledCount })}
              </div>
            </div>
            <div className="editor-setting-actions">
              <button
                type="button"
                className="batch-generate-btn"
                onClick={generateImages}
                disabled={disabled || batchBusy || titled.length === 0}
              >
                <Sparkles className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                {imagesBusy ? t('graph:selection.images.busy') : t('graph:selection.images.label')}
              </button>
              {canGenerateAudio && (
                <button
                  type="button"
                  className="batch-generate-btn"
                  onClick={generateAudios}
                  disabled={disabled || batchBusy || titled.length === 0}
                >
                  <Speech className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  {audiosBusy ? t('graph:selection.audios.busy') : t('graph:selection.audios.label')}
                </button>
              )}
            </div>
          </div>
          {batchError.length > 0 && (
            <div className="advanced-selection-editor__error" role="alert">{batchError.map((message) => t(message.key, message.params)).join(' · ')}</div>
          )}
        </div>
      )}

      {stages.length > 0 && (
        <section className="card advanced-editor__section advanced-controls">
          <div className="card-title-row">
            <div className="card-title">{t('graph:selection.controls.title')}</div>
            <div className="card-copy card-copy--inline">
              {withControls.length > 0
                ? t('graph:selection.controls.description', { count: withControls.length })
                : t('graph:selection.controls.empty')}
            </div>
          </div>
          {withoutControlsCount > 0 && (
            <p className="advanced-field__note">
              {t('graph:selection.controls.undefined', { count: withoutControlsCount })}
            </p>
          )}
          {withControls.length > 0 && (
            <GroupedControls
              renderControl={(control, label) => {
                const state = sharedControlState(withControls, control);
                return (
                  <label key={control} className="sequence-control">
                    <span>{label}</span>
                    <Toggle
                      on={state === 'on'}
                      mixed={state === 'mixed'}
                      // Allumer Accueil sur l'Écran d'entrée le ferait tourner
                      // en rond : il reste en dehors du geste groupé.
                      onChange={(value) => onSetControls(
                        withControls
                          .filter((entry) => !(control === 'home' && value && isEntryStage(entry)))
                          .map((entry) => entry.node.uuid),
                        control,
                        value,
                      )}
                      ariaLabel={t('graph:selection.controls.aria', { control: label })}
                      disabled={disabled}
                    />
                  </label>
                );
              }}
            />
          )}
        </section>
      )}

      <div className="card">
        <NodeColorPicker
          label={currentColor === '__mixed__'
            ? t('graph:selection.color.mixed', { count: entries.length })
            : t('graph:selection.color.label', { count: entries.length })}
          currentColor={currentColor}
          disabled={disabled}
          onChange={(color) => onSetColor(paths, color)}
        />
      </div>

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={() => onDelete(paths)}
            disabled={disabled}
            aria-label={t('graph:selection.remove.label')}
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">{t('graph:selection.remove.label')}</span>
          <p className="card-danger-desc">
            {t('graph:selection.remove.description', { selection: parts.length === 2 ? t('graph:selection.counts.join', { stages: parts[0], actions: parts[1] }) : parts[0] ?? '' })}
          </p>
        </div>
      </div>
    </div>
  );
}
