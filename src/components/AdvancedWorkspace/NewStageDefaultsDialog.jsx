import { useTranslation } from 'react-i18next';
import { translateGraph as t, graphTranslationEngine } from '../../i18n/graphPresentation.js';
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
import { ADVANCED_CONTROL_KEYS } from '../../store/projectModel/advancedGestures.js';
import {
  DEFAULT_NEW_STAGE_CONTROLS,
  completeStageControls,
  readNewStageControls,
  sameControls,
  writeNewStageControls,
} from '../../store/advancedAuthoring/newStageControls.js';


// Présentation des contrôles des créations ; les clés serviront aussi aux
// réglages d’un Écran. Les groupes et l’ordre historiques sont conservés.
const CREATION_CONTROL_GROUPS = [
  { id: 'ok', titleKey: 'graph:edge.route.label', term: 'okTransition', controls: ['ok', 'autoplay'] },
  { id: 'home', titleKey: 'graph:edge.boutonAccueil.label', term: 'homeTransition', controls: ['home'] },
  { id: 'wheel', titleKey: 'graph:creationControls.wheel.groupTitle', term: null, controls: ['wheel'] },
  { id: 'pause', titleKey: 'graph:creationControls.pause.groupTitle', term: null, controls: ['pause'] },
];
const CREATION_CONTROL_LABELS = {
  ok: 'graph:creationControls.ok.phrase', autoplay: 'graph:creationControls.autoplay.phrase',
  home: 'graph:edge.boutonAccueil.label', pause: 'graph:creationControls.pause.label', wheel: 'graph:creationControls.wheel.label',
};
const CREATION_CONTROL_SHORT_LABELS = {
  wheel: 'graph:creationControls.wheel.label', ok: 'graph:creationControls.ok.label', home: 'graph:edge.boutonAccueil.label',
  pause: 'graph:creationControls.pause.label', autoplay: 'graph:creationControls.autoplay.label',
};
export function CreationControlGroups({ renderControl }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  return CREATION_CONTROL_GROUPS.map(group => (
    <div key={group.id} className="advanced-control-group">
      <div className="advanced-exit__label">
        {t(group.titleKey)}
        {group.term && <em className="advanced-editor__term">{group.term}</em>}
      </div>
      <div className="sequence-controls advanced-controls__toggles">
        {group.controls.map(control => renderControl(control, t(CREATION_CONTROL_LABELS[control])))}
      </div>
    </div>
  ));
}
function describeCreationControls(controls) {
  const on = ADVANCED_CONTROL_KEYS.filter(key => controls?.[key] === true).map(key => t(CREATION_CONTROL_SHORT_LABELS[key]));
  return on.length > 0 ? on.join(' · ') : t('graph:creationControls.empty.label');
}

// Le contenu de la fenêtre, sans son châssis : les boutons du brouillon, puis
// les deux raccourcis pour le remplir.
export function NewStageDefaultsForm({ draft, onChange, selectedStage = null }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const fromSelection = selectedStage ? completeStageControls(selectedStage.node.controls) : null;
  const selectionName = selectedStage?.label?.label ?? '';
  return (
    <>
      <fieldset className="advanced-field advanced-link-dialog__controls">
        <legend>{t("graph:defaults.templateButtons.label")}</legend>
        <CreationControlGroups
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
            {t('graph:defaults.selection.reuse', { name: selectionName })}
          </button>
        )}
        {!sameControls(DEFAULT_NEW_STAGE_CONTROLS, draft) && (
          <button type="button" className="advanced-link" onClick={() => onChange({ ...DEFAULT_NEW_STAGE_CONTROLS })}>
            {t('graph:defaults.controls.restore', { controls: describeCreationControls(DEFAULT_NEW_STAGE_CONTROLS) })}
          </button>
        )}
      </div>
    </>
  );
}

export function NewStageDefaultsDialog({ selectedStage = null, onClose }) {
  useTranslation('graph', { i18n: graphTranslationEngine() });
  const [draft, setDraft] = useState(() => ({ ...readNewStageControls() }));
  return (
    <AdvancedDialog
      title={t("graph:defaults.newStageButtons.label")}
      description={t("graph:defaults.eachStageCreatedInTheGraphStartsWithThese.label")}
      onCancel={onClose}
      onConfirm={() => {
        writeNewStageControls(draft);
        onClose();
      }}
      confirmLabel={t("common:project.save.label")}
    >
      <NewStageDefaultsForm draft={draft} onChange={setDraft} selectedStage={selectedStage} />
    </AdvancedDialog>
  );
}
