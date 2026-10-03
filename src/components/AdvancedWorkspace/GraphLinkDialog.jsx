// La fenêtre d'un trait lâché dans le vide : créer le nœud qui manque au bout,
// et son raccord, en un seul geste.
//
// Un trait lâché sur un nœud existant se raccorde sans fenêtre
// (`isGraphLinkAutoApplyable`) : seule la création a encore des questions à
// poser — le nom du nœud, et pour un Écran, sa place parmi les destinations et
// ses boutons.

import { useState } from 'react';

import { Toggle } from '../common/Toggle';
import { AdvancedDialog } from './AdvancedDialog.jsx';
import { GroupedControls } from './ControlsEditor.jsx';
import { NodePicker } from './NodePicker.jsx';
import {
  advancedGestures,
  optionTarget,
} from '../../store/projectModel/advancedGestures.js';
import { nextDefaultNodeName } from '../../store/advancedAuthoring/defaultNodeNames.js';
import {
  readNewStageControls,
  writeNewStageControls,
} from '../../store/advancedAuthoring/newStageControls.js';
import { ACTION_KIND, STAGE_KIND } from '../../store/advancedGraphView/graphViewModel.js';

const trimmedOrNull = value => value.trim() || null;

function InsertionChoice({ id, count, value, onChange }) {
  return (
    <select id={id} value={String(value)} onChange={(event) => onChange(Number(event.target.value))}>
      <option value={String(count)}>À la fin</option>
      {Array.from({ length: count }, (unused, index) => (
        <option key={index} value={String(index)}>
          {index === 0 ? 'Au début' : `Avant le choix ${index + 1}`}
        </option>
      ))}
    </select>
  );
}

export function GraphLinkDialog({ index, intent, busy, onCancel, onConfirm }) {
  const source = index.byPath.get(intent.sourcePath);
  const sourceIsStage = intent.sourceKind === 'stage';
  const optionCount = sourceIsStage ? 0 : (source?.node.options?.length ?? 0);
  const [insertionIndex, setInsertionIndex] = useState(intent.suggestedIndex ?? optionCount);
  // Le nœud créé est pré-nommé « Écran N » ou « Action N » : l'auteur voit le
  // nom avant qu'il soit donné, et le garde ou le change.
  // Un champ vidé reprend ce nom : un nœud créé ici n'est jamais sans nom.
  const [defaultName] = useState(() => nextDefaultNodeName(
    index,
    sourceIsStage ? ACTION_KIND : STAGE_KIND,
  ));
  const [name, setName] = useState(defaultName);
  const [destinationPath, setDestinationPath] = useState(null);
  // Les boutons du nouvel Écran partent du réglage retenu par l'auteur.
  const [controls, setControls] = useState(() => ({ ...readNewStageControls() }));
  const [remember, setRemember] = useState(false);
  const fillsMissing = intent.missingOptionIndex !== null && intent.missingOptionIndex !== undefined;

  const confirm = () => {
    if (!source) return;
    if (sourceIsStage) {
      const targetStage = destinationPath ? index.byPath.get(destinationPath) : null;
      onConfirm(advancedGestures.createLinkedNode({
        direction: 'stage-to-action',
        stageUuid: source.node.uuid,
        slot: intent.slot,
        action: {
          id: null,
          name: trimmedOrNull(name) ?? defaultName,
          // Une première occurrence existe immédiatement. Elle peut rester à
          // raccorder, mais l'Action créée n'est jamais vide.
          options: [targetStage ? optionTarget.stage(targetStage.node.uuid) : optionTarget.null()],
        },
        optionIndex: 0,
        ...(intent.activateControl ? { activateControl: true } : {}),
        position: intent.graphPoint,
      }));
      return;
    }
    if (remember) writeNewStageControls(controls);
    onConfirm(advancedGestures.createLinkedNode({
      direction: 'action-to-stage',
      actionId: source.node.id,
      index: fillsMissing ? intent.missingOptionIndex : insertionIndex,
      ...(fillsMissing ? { replaceMissing: true } : {}),
      stage: { name: trimmedOrNull(name) ?? defaultName, controls },
      position: intent.graphPoint,
    }));
  };

  const sourceName = source?.label.label ?? '';
  const exitName = intent.slot === 'home' ? 'Le bouton Accueil' : 'La suite du parcours';
  const buttonName = intent.slot === 'home' ? 'Le bouton Accueil' : 'Le bouton OK';

  return (
    <AdvancedDialog
      title={sourceIsStage ? 'Créer une liste de choix' : 'Créer un Écran'}
      description={sourceIsStage
        ? `${exitName} de « ${sourceName} » ouvrira cette nouvelle liste de choix.`
        : `« ${sourceName} » proposera ce nouvel Écran parmi ses choix.`}
      onCancel={onCancel}
      onConfirm={confirm}
      confirmLabel="Créer"
      confirmDisabled={!source}
      busy={busy}
    >
      {!source && (
        <p className="advanced-field__warning" role="alert">
          Le graphe a changé depuis le début du trait. Fermez cette fenêtre et recommencez.
        </p>
      )}

      {source && (
        <>
          <label className="advanced-field__label" htmlFor="graph-linked-name">Nom</label>
          <input id="graph-linked-name" value={name} onChange={(event) => setName(event.target.value)} />
        </>
      )}

      {source && sourceIsStage && (
        <>
          {intent.activateControl && (
            <p className="advanced-field__note">{buttonName} de « {sourceName} » sera aussi activé.</p>
          )}
          <label className="advanced-field__label" htmlFor="graph-linked-destination">Premier choix</label>
          <NodePicker
            id="graph-linked-destination"
            forChoice
            index={index}
            kind="stage"
            value={destinationPath}
            onChange={setDestinationPath}
            emptyLabel="— à choisir plus tard —"
          />
        </>
      )}

      {source && !sourceIsStage && (
        <>
          {fillsMissing
            ? <p className="advanced-field__note">Le nouvel Écran prendra la place du choix {intent.missingOptionIndex + 1}, resté vide.</p>
            : (
              <>
                <label className="advanced-field__label" htmlFor="graph-linked-rank">Place parmi les choix</label>
                <InsertionChoice id="graph-linked-rank" count={optionCount} value={insertionIndex} onChange={setInsertionIndex} />
              </>
            )}
          <fieldset className="advanced-field advanced-link-dialog__controls">
            <legend>Boutons du nouvel Écran</legend>
            <GroupedControls
              renderControl={(key, label) => (
                <label key={key} className="sequence-control">
                  <span>{label}</span>
                  <Toggle
                    on={controls[key]}
                    onChange={(value) => setControls((current) => ({ ...current, [key]: value }))}
                    ariaLabel={label}
                  />
                </label>
              )}
            />
            <label className="advanced-link-dialog__remember">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>En faire le modèle des nouveaux Écrans</span>
            </label>
          </fieldset>
        </>
      )}
    </AdvancedDialog>
  );
}
