// La fenêtre du modèle des nouveaux Écrans : les cinq boutons avec lesquels
// naît chaque Écran créé dans le graphe.
//
// Ce n'est pas un réglage d'un Écran — c'est une préférence de l'application,
// ouverte depuis la commande « Créer un Écran » qu'elle gouverne. Elle ne vit
// donc pas dans le panneau d'un Écran, déjà assez chargé. Quand un Écran est
// sélectionné, la fenêtre propose de reprendre ses boutons : l'auteur règle un
// Écran comme il le veut, puis en fait le modèle d'une série.

import { useState } from 'react';

import { Toggle } from '../common/Toggle';
import { AdvancedDialog } from './AdvancedDialog.jsx';
import { GroupedControls, describeControls } from './ControlsEditor.jsx';
import {
  DEFAULT_NEW_STAGE_CONTROLS,
  completeStageControls,
  readNewStageControls,
  sameControls,
  writeNewStageControls,
} from '../../store/advancedAuthoring/newStageControls.js';

// Le contenu de la fenêtre, sans son châssis : les boutons du brouillon, puis
// les deux raccourcis pour le remplir.
export function NewStageDefaultsForm({ draft, onChange, selectedStage = null }) {
  const fromSelection = selectedStage ? completeStageControls(selectedStage.node.controls) : null;
  const selectionName = selectedStage?.label?.label ?? '';
  return (
    <>
      <fieldset className="advanced-field advanced-link-dialog__controls">
        <legend>Boutons du modèle</legend>
        <GroupedControls
          renderControl={(key, label) => (
            <label key={key} className="sequence-control">
              <span>{label}</span>
              <Toggle
                on={draft[key]}
                onChange={(value) => onChange({ ...draft, [key]: value })}
                ariaLabel={label}
              />
            </label>
          )}
        />
      </fieldset>
      <div className="advanced-field__actions">
        {fromSelection && !sameControls(fromSelection, draft) && (
          <button type="button" className="advanced-link" onClick={() => onChange({ ...fromSelection })}>
            Reprendre les boutons de « {selectionName} »
          </button>
        )}
        {!sameControls(DEFAULT_NEW_STAGE_CONTROLS, draft) && (
          <button type="button" className="advanced-link" onClick={() => onChange({ ...DEFAULT_NEW_STAGE_CONTROLS })}>
            Revenir au réglage d’origine ({describeControls(DEFAULT_NEW_STAGE_CONTROLS)})
          </button>
        )}
      </div>
    </>
  );
}

export function NewStageDefaultsDialog({ selectedStage = null, onClose }) {
  const [draft, setDraft] = useState(() => ({ ...readNewStageControls() }));
  return (
    <AdvancedDialog
      title="Boutons des nouveaux Écrans"
      description="Chaque Écran créé dans le graphe naît avec ces boutons. C’est une préférence de l’application : elle ne modifie aucun Écran existant."
      onCancel={onClose}
      onConfirm={() => {
        writeNewStageControls(draft);
        onClose();
      }}
      confirmLabel="Enregistrer"
    >
      <NewStageDefaultsForm draft={draft} onChange={setDraft} selectedStage={selectedStage} />
    </AdvancedDialog>
  );
}
