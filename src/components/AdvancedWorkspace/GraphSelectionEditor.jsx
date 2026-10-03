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

const plural = (count, one, many) => `${count} ${count > 1 ? many : one}`;

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
  const {
    xttsSettings,
    onQueueXttsGenerate,
    onMediaCreated,
    savePath,
    workspaceDir,
  } = useProjectContext();
  const { showErrorDialog } = useErrorDialog();
  const [imagesBusy, setImagesBusy] = useState(false);
  const [audiosBusy, setAudiosBusy] = useState(false);
  const [batchError, setBatchError] = useState('');

  const paths = entries.map((entry) => entry.path);
  const stages = entries.filter((entry) => entry.kind === STAGE_KIND);
  const actionCount = entries.length - stages.length;
  const titled = stages.filter((entry) => stageTitle(entry) !== '');
  const untitledCount = stages.length - titled.length;
  const batchBusy = imagesBusy || audiosBusy;
  const withControls = stages.filter((entry) => entry.node.controls?.presence === 'value');
  const withoutControlsCount = stages.length - withControls.length;

  const parts = [];
  if (stages.length > 0) parts.push(plural(stages.length, 'Écran', 'Écrans'));
  if (actionCount > 0) parts.push(plural(actionCount, 'liste de choix', 'listes de choix'));

  const colors = [...new Set(entries.map((entry) => entry.node?.personalColor ?? null))];
  const currentColor = colors.length === 1 ? colors[0] : '__mixed__';

  async function generateImages() {
    if (batchBusy || disabled) return;
    setBatchError('');
    setImagesBusy(true);
    const errors = [];
    try {
      for (const entry of titled) {
        const title = stageTitle(entry);
        try {
          const imagePath = await generateTextImage(title, workspaceDir);
          if (!imagePath) continue;
          onMediaCreated?.(imagePath);
          await onAssignMedia(entry.node.uuid, 'image', imagePath);
        } catch {
          errors.push(`${title} : image-titre impossible à générer`);
        }
      }
    } finally {
      setImagesBusy(false);
      if (errors.length > 0) setBatchError(errors.join(' · '));
    }
  }

  async function generateAudios() {
    if (batchBusy || disabled) return;
    setBatchError('');
    const voice = batchTitleVoice(xttsSettings);
    if (!voice) {
      const message = 'Choisis une voix XTTS une première fois (depuis le bouton TTS d’un audio) avant de lancer la génération groupée.';
      setBatchError(message);
      showErrorDialog({ title: 'Génération audio', message, variant: 'warning' });
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
            targetLabel: `${title} — titre`,
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
          errors.push(`${title} : job de voix non ajouté`);
        }
      }
    } finally {
      setAudiosBusy(false);
      if (errors.length > 0) setBatchError(errors.join(' · '));
    }
  }

  const canGenerateAudio = isTtsAvailable(xttsSettings);

  return (
    <div className="advanced-selection-editor">
      <div className="advanced-selection-editor__banner">
        {entries.length} nœuds sélectionnés : {parts.join(', ')}.
      </div>

      {stages.length > 0 && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">Génération groupée</div>
          </div>
          <div className="editor-setting-row is-action-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">Générer à partir des noms</div>
              <div className="editor-setting-desc">
                {titled.length > 0
                  ? `Crée d'un coup une image-titre ou un audio (le nom prononcé) pour ${plural(titled.length, 'Écran nommé', 'Écrans nommés')}. Chacun remplace le média de son Écran.`
                  : 'Aucun Écran sélectionné ne porte de nom : il n’y a pas de titre à générer.'}
                {untitledCount > 0 && titled.length > 0
                  && ` ${plural(untitledCount, 'Écran sans nom est ignoré', 'Écrans sans nom sont ignorés')}.`}
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
                {imagesBusy ? 'Images…' : 'Images-titres'}
              </button>
              {canGenerateAudio && (
                <button
                  type="button"
                  className="batch-generate-btn"
                  onClick={generateAudios}
                  disabled={disabled || batchBusy || titled.length === 0}
                >
                  <Speech className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  {audiosBusy ? 'Audios…' : 'Audios titres'}
                </button>
              )}
            </div>
          </div>
          {batchError && (
            <div className="advanced-selection-editor__error" role="alert">{batchError}</div>
          )}
        </div>
      )}

      {stages.length > 0 && (
        <section className="card advanced-editor__section advanced-controls">
          <div className="card-title-row">
            <div className="card-title">Boutons des Écrans</div>
            <div className="card-copy card-copy--inline">
              {withControls.length > 0
                ? `Réglés d’un coup sur ${plural(withControls.length, 'Écran', 'Écrans')}. Les destinations se règlent Écran par Écran.`
                : 'Aucun Écran sélectionné n’a de boutons définis.'}
            </div>
          </div>
          {withoutControlsCount > 0 && (
            <p className="advanced-field__note">
              {plural(withoutControlsCount, 'Écran n’a', 'Écrans n’ont')} pas encore de boutons
              définis : {withoutControlsCount > 1 ? 'ils sont laissés' : 'il est laissé'} de côté.
              Définissez-les Écran par Écran, depuis son propre panneau.
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
                      ariaLabel={`${label} — sur la sélection`}
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
            ? `Couleur — différente sur ${entries.length} nœuds, choisir pour uniformiser`
            : `Couleur des ${entries.length} nœuds`}
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
            aria-label="Retirer la sélection"
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">Retirer la sélection</span>
          <p className="card-danger-desc">
            Retire {parts.join(' et ')} du graphe, après confirmation.
          </p>
        </div>
      </div>
    </div>
  );
}
