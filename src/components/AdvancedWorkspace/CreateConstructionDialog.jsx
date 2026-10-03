import { useState } from 'react';
import { AdvancedDialog } from './AdvancedDialog.jsx';
import { NodePicker } from './NodePicker.jsx';
import { Button } from '../common/Button';
import { Toggle } from '../common/Toggle';
import { GroupedControls } from './ControlsEditor.jsx';
import {
  buildConstructionGesture, CONSTRUCTION_LABELS, NARRATIVE_CONTROLS, CHOICE_CONTROLS,
} from '../../store/advancedAuthoring/constructions.js';

// Les interrupteurs et les libellés du panneau d'un Écran.
function ConstructionControls({ title, value, onChange }) {
  return (
    <fieldset className="advanced-field">
      <legend>{title}</legend>
      <GroupedControls
        renderControl={(key, label) => (
          <label key={key} className="sequence-control">
            <span>{label}</span>
            <Toggle
              on={value[key]}
              onChange={(next) => onChange({ ...value, [key]: next })}
              ariaLabel={label}
            />
          </label>
        )}
      />
    </fieldset>
  );
}

export function CreateConstructionDialog({ index, busy, onCancel, onConfirm }) {
  const [kind, setKind] = useState('scene');
  const [name, setName] = useState('');
  const [items, setItems] = useState([{ key: 0, name: '', targetPath: null }, { key: 1, name: '', targetPath: null }]);
  const [nextKey, setNextKey] = useState(2);
  const [controls, setControls] = useState({ ...NARRATIVE_CONTROLS });
  const [optionControls, setOptionControls] = useState({ ...CHOICE_CONTROLS });
  const [question, setQuestion] = useState(true);
  const [sourcePath, setSourcePath] = useState(null);
  const [destinationPath, setDestinationPath] = useState(null);
  const [trigger, setTrigger] = useState('autoplay');
  const setItem = (key, change) => setItems((current) => current.map((item) => item.key === key ? { ...item, ...change } : item));
  const moveItem = (position, delta) => setItems((current) => {
    const next = [...current];
    [next[position], next[position + delta]] = [next[position + delta], next[position]];
    return next;
  });
  let gesture = null;
  let error = null;
  try {
    gesture = buildConstructionGesture(index, { kind, name, items, controls, optionControls, question, sourcePath, destinationPath, trigger });
  } catch (cause) { error = cause.message; }

  return (
    <AdvancedDialog
      title="Constructions dérivées"
      description="Ces raccourcis créent des Écrans et des listes de choix ordinaires, modifiables séparément. L’ensemble se crée et s’annule en une seule opération."
      busy={busy} onCancel={onCancel} onConfirm={() => onConfirm(gesture)}
      confirmLabel={{ scene: 'Créer la scène', choice: 'Créer le choix', sequence: 'Créer la séquence', random: 'Créer le tirage au sort' }[kind]}
      confirmDisabled={!gesture}
    >
      <fieldset disabled={busy} className="advanced-field">
        <label className="advanced-field__label" htmlFor="construction-kind">Construction</label>
        <select id="construction-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
          {Object.entries(CONSTRUCTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {kind !== 'sequence' && (
          <>
            <label className="advanced-field__label" htmlFor="construction-name">{kind === 'choice' && question ? 'Nom de la question et du choix' : 'Nom'}</label>
            <input id="construction-name" value={name} onChange={(event) => setName(event.target.value)} />
          </>
        )}
        {kind === 'choice' && (
          <label className="advanced-controls__row">
            <span>Un Écran de question avant les propositions</span>
            <input type="checkbox" checked={question} onChange={(event) => setQuestion(event.target.checked)} />
          </label>
        )}
        {kind !== 'scene' && (
          <fieldset className="advanced-field">
            <legend>{kind === 'choice' ? 'Propositions, dans l’ordre de la molette' : kind === 'sequence' ? 'Passages, dans l’ordre de lecture' : 'Destinations du tirage'}</legend>
            <ol className="advanced-options">
              {items.map((item, position) => (
                <li key={item.key} className="advanced-field">
                  <label className="advanced-field__label" htmlFor={`construction-item-${item.key}`}>{position + 1}. {kind === 'random' ? 'Nom du nouvel Écran (si aucune cible existante)' : 'Nom'}</label>
                  <input id={`construction-item-${item.key}`} value={item.name} onChange={(event) => setItem(item.key, { name: event.target.value })} disabled={kind === 'random' && !!item.targetPath} />
                  {kind !== 'sequence' && (
                    <>
                      <label className="advanced-field__label" htmlFor={`construction-target-${item.key}`}>{kind === 'choice' ? 'Après validation, aller à' : 'Ou réutiliser cet Écran'}</label>
                      <NodePicker id={`construction-target-${item.key}`} index={index} kind="stage" forChoice value={item.targetPath}
                        onChange={(targetPath) => setItem(item.key, { targetPath })}
                        emptyLabel={kind === 'choice' ? '— destination commune ci-dessous —' : '— créer un nouvel Écran —'} />
                    </>
                  )}
                  <div className="advanced-dialog__footer">
                    <Button size="sm" disabled={position === 0} onClick={() => moveItem(position, -1)}>Monter</Button>
                    <Button size="sm" disabled={position === items.length - 1} onClick={() => moveItem(position, 1)}>Descendre</Button>
                    <Button size="sm" onClick={() => setItems((current) => current.filter((row) => row.key !== item.key))}>Retirer</Button>
                  </div>
                </li>
              ))}
            </ol>
            <Button size="sm" onClick={() => {
              setItems((current) => [...current, { key: nextKey, name: '', targetPath: null }]);
              setNextKey((current) => current + 1);
            }}>Ajouter {kind === 'choice' ? 'une proposition' : kind === 'sequence' ? 'un passage' : 'une destination'}</Button>
          </fieldset>
        )}
        <fieldset className="advanced-field">
          <legend>Suite {kind === 'choice' ? 'commune (sauf destination par proposition)' : ''}</legend>
          <label className="advanced-field__label" htmlFor="construction-destination">Destination finale</label>
          <NodePicker id="construction-destination" index={index} kind="stage" forChoice value={destinationPath} onChange={setDestinationPath} emptyLabel="— à raccorder plus tard —" />
          <p className="advanced-field__note">{kind === 'random' ? 'Cette suite concerne uniquement les nouveaux Écrans. Les Écrans réutilisés gardent leurs contrôles et leurs transitions.' : kind === 'sequence' ? 'Seule la dernière scène rejoint cette destination.' : 'Sans destination, les sorties restent à raccorder.'}</p>
        </fieldset>
        {(kind !== 'choice' || question) && <ConstructionControls title="Boutons des Écrans de lecture" value={controls} onChange={setControls} />}
        {kind === 'choice' && <ConstructionControls title="Boutons des Écrans de choix" value={optionControls} onChange={setOptionControls} />}
        <fieldset className="advanced-field">
          <legend>Arrivée {kind === 'random' ? '(obligatoire pour le tirage)' : '(facultative)'}</legend>
          <label className="advanced-field__label" htmlFor="construction-source">Écran de départ</label>
          <NodePicker id="construction-source" index={index} kind="stage" value={sourcePath} onChange={setSourcePath} emptyLabel="— créer sans arrivée —" />
          {sourcePath && (
            <>
              <label className="advanced-field__label" htmlFor="construction-trigger">Depuis cet Écran</label>
              <select id="construction-trigger" value={trigger} onChange={(event) => setTrigger(event.target.value)}>
                <option value="autoplay">Suite du parcours, à la fin du son</option><option value="ok">Suite du parcours, au bouton OK</option><option value="home">Bouton Accueil</option>
              </select>
              <p className="advanced-field__warning">
                Ce raccord remplace {trigger === 'home' ? 'la destination du bouton Accueil (homeTransition)' : 'la suite du parcours (okTransition)'} de l’Écran choisi
                et active {trigger === 'autoplay' ? 'la suite automatique à la fin du son' : trigger === 'ok' ? 'le bouton OK' : 'le bouton Accueil'}.
                Les autres contrôles restent inchangés.
              </p>
              <p className="advanced-field__note">{kind === 'random' ? 'La transition tirera un choix au sort à chaque ouverture.' : 'Les listes de raccord s’ouvrent sur leur premier choix.'}</p>
            </>
          )}
        </fieldset>
        <p className="advanced-field__note">Les images et audios pourront être ajoutés sur chaque Écran après la création. Aucun regroupement ni nouveau type de nœud n’est créé.</p>
        {error && <p className="advanced-field__note" role="status">{error}</p>}
      </fieldset>
    </AdvancedDialog>
  );
}
