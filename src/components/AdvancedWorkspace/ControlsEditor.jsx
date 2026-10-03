// Les cinq contrôles d'un Écran, chacun **indépendamment**.
//
// Le panneau ne les range plus dans un encadré à part : chaque contrôle vit
// à côté de ce qu'il déclenche — OK et la lecture automatique sous la suite
// du parcours, Accueil sous sa destination, la molette avec les listes par
// lesquelles on arrive. Ce fichier fournit les briques communes.
//
// Trois règles du dialecte tiennent ces briques, et aucune n'est une
// préférence d'affichage :
//
// - Un contrôle absent n'est pas `false`. Les trois présences sont proposées
//   telles quelles, et « absent » n'est jamais coché à la place de l'auteur.
// - Un booléen de contrôle et une transition sont deux informations
//   distinctes. Montrés côte à côte, ils restent deux gestes : modifier `ok`
//   n'efface aucune transition, et poser une transition n'allume aucun
//   contrôle.
// - Seule la forme complète sort d'un pack. Compléter est donc offert — mais
//   comme un **choix explicite des cinq**, jamais comme une déduction à partir
//   de ce qui est déjà là.

import { useState } from 'react';

import { Button } from '../common/Button';
import { Toggle } from '../common/Toggle';
import { ADVANCED_CONTROL_KEYS, advancedGestures, presence } from '../../store/projectModel/advancedGestures.js';

// Les noms courts des cinq boutons, pour les résumés en une ligne
// (« Molette · Bouton OK »). Partout où on les règle, ils sont rangés et
// formulés par `CONTROL_GROUPS` et `CONTROL_PHRASES`.
const CONTROL_LABELS = {
  wheel: 'Molette',
  ok: 'Bouton OK',
  home: 'Bouton Accueil',
  pause: 'Bouton Pause',
  autoplay: 'Lecture automatique',
};

// Chaque bouton formulé par ce qu'il fait, le même texte partout : panneau
// d'un Écran, sélection multiple, fenêtres de création.
export const CONTROL_PHRASES = {
  ok: 'Quand on appuie sur OK',
  // « Automatiquement » est implicite sous « Se déclenche », et ce mot seul
  // déborde d'une colonne de 200 px.
  autoplay: 'À la fin du son',
  // Accueil et Pause sont des boutons qu'on active ou non : leur nom reste
  // fixe, et l'état se lit à côté (`STATE_WORDED`).
  home: 'Bouton Accueil',
  pause: 'Bouton Pause',
  wheel: 'Molette',
};

// Les contrôles dont la ligne dit son état en toutes lettres, « activé » ou
// « désactivé » : un bouton nommé seul ne dirait pas s'il marche. Les
// déclencheurs de la suite, formulés en condition, se lisent sans.
const STATE_WORDED = new Set(['home', 'pause', 'wheel']);

// Les boutons rangés par ce qu'ils déclenchent, dans l'ordre du panneau d'un
// Écran : la suite du parcours et ses deux déclencheurs, le bouton Accueil,
// la molette, qui fait passer aux autres choix de la liste, puis la pause.
const CONTROL_GROUPS = [
  { id: 'ok', title: 'Suite du parcours', term: 'okTransition', controls: ['ok', 'autoplay'] },
  { id: 'home', title: 'Bouton Accueil', term: 'homeTransition', controls: ['home'] },
  { id: 'wheel', title: 'Passer aux autres choix de la liste', term: null, controls: ['wheel'] },
  { id: 'pause', title: 'Pendant la lecture', term: null, controls: ['pause'] },
];

// Les cinq boutons regroupés, là où on les règle ensemble sans leurs
// destinations : chaque appelant fournit sa ligne (interrupteur simple,
// mixte, ou valeur d'un brouillon).
export function GroupedControls({ renderControl }) {
  return CONTROL_GROUPS.map((group) => (
    <div key={group.id} className="advanced-control-group">
      <div className="advanced-exit__label">
        {group.title}
        {group.term && <em className="advanced-editor__term">{group.term}</em>}
      </div>
      <div className="sequence-controls advanced-controls__toggles">
        {group.controls.map((control) => renderControl(control, CONTROL_PHRASES[control]))}
      </div>
    </div>
  ));
}

const PRESENCE_CHOICES = [
  ['true', 'Activé'],
  ['false', 'Désactivé'],
  ['null', 'Non défini (null)'],
  ['absent', 'Non défini (absent)'],
];

// « Molette · Bouton OK · Bouton Accueil » : les boutons allumés, dans l’ordre.
export function describeControls(controls) {
  const on = ADVANCED_CONTROL_KEYS.filter((key) => controls?.[key] === true).map((key) => CONTROL_LABELS[key]);
  return on.length > 0 ? on.join(' · ') : 'aucun bouton';
}

// `true`, `false`, ou `null` quand le document ne dit rien : un contrôle non
// défini n'est ni allumé ni éteint.
export function controlValue(stage, control) {
  const member = stage.controls?.[control];
  return member?.presence === 'value' ? member.value === true : null;
}

function presenceKey(field) {
  if (!field || field.presence === 'absent') return 'absent';
  if (field.presence === 'null') return 'null';
  return field.value === true ? 'true' : 'false';
}

function updateFor(key) {
  if (key === 'absent') return presence.absent();
  if (key === 'null') return presence.null();
  return presence.value(key === 'true');
}

// Un contrôle, sur sa ligne : un interrupteur quand il est défini, le choix
// des quatre présences sinon.
export function ControlRow({ stage, control, label, disabled, onGesture }) {
  const field = stage.controls?.[control];
  const set = (key) => {
    onGesture(advancedGestures.setStageControls(stage.uuid, { [control]: updateFor(key) }));
  };
  if (field?.presence === 'value') {
    return (
      <label className="sequence-control">
        <span>
          {label}
          {STATE_WORDED.has(control) && (
            <span className="advanced-controls__state">{field.value === true ? 'activé' : 'désactivé'}</span>
          )}
        </span>
        <Toggle
          on={field.value === true}
          onChange={(value) => set(value ? 'true' : 'false')}
          ariaLabel={label}
          disabled={disabled}
        />
      </label>
    );
  }
  return (
    <label className="advanced-controls__row is-undefined">
      <span className="advanced-controls__name">{label}</span>
      <select
        value={presenceKey(field)}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => set(event.target.value)}
      >
        {PRESENCE_CHOICES.map(([value, text]) => (
          <option key={value} value={value}>{text}</option>
        ))}
      </select>
    </label>
  );
}

// Des boutons non définis empêchent de générer : l'encadré n'apparaît que
// dans ce cas, en tête des réglages, et propose de définir les cinq d'un coup.
export function ControlsCompletion({ stage, disabled, onGesture, highlight = false }) {
  const controls = stage.controls ?? {};
  const [completion, setCompletion] = useState(null);
  if (controls.presence === 'value' && controls.complete !== false) return null;

  const startCompletion = () => {
    // Le formulaire part de ce qui est **connu**, et laisse indéterminé ce qui
    // ne l'est pas : `null` ou absent ne deviennent pas `false` en s'affichant.
    setCompletion(Object.fromEntries(ADVANCED_CONTROL_KEYS.map((control) => [
      control,
      controls[control]?.presence === 'value' ? controls[control].value : null,
    ])));
  };

  const completionReady = completion !== null
    && ADVANCED_CONTROL_KEYS.every((control) => typeof completion[control] === 'boolean');

  return (
    <section className="card advanced-editor__section advanced-controls" data-highlight={highlight ? 'true' : undefined}>
      <div className="card-title-row">
        <div className="card-title">
          Boutons <span className="advanced-field__flag">— à définir</span>
        </div>
      </div>
      <p className="advanced-field__note">
        {controls.presence !== 'value'
          ? 'Les boutons de cet Écran n’ont pas encore été définis dans le document.'
          : 'Certains boutons de cet Écran ne sont pas définis.'}
        {' '}Choisissez le comportement de chacun pour pouvoir générer le pack.
      </p>

      {completion === null ? (
        <Button size="sm" onClick={startCompletion} disabled={disabled}>
          Définir les cinq réglages…
        </Button>
      ) : (
        <div className="advanced-controls__completion">
          {ADVANCED_CONTROL_KEYS.map((control) => (
            <label key={control} className="advanced-controls__row">
              <span className="advanced-controls__name">{CONTROL_LABELS[control]}</span>
              <select
                value={completion[control] === null ? '' : String(completion[control])}
                aria-label={`Compléter ${CONTROL_LABELS[control]}`}
                onChange={(event) => setCompletion((current) => ({
                  ...current,
                  [control]: event.target.value === '' ? null : event.target.value === 'true',
                }))}
              >
                <option value="">— à définir —</option>
                <option value="true">Activé</option>
                <option value="false">Désactivé</option>
              </select>
            </label>
          ))}
          <div className="advanced-controls__completion-actions">
            <Button size="sm" onClick={() => setCompletion(null)}>Annuler</Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!completionReady || disabled}
              onClick={() => {
                onGesture(advancedGestures.completeStageControls(stage.uuid, completion));
                setCompletion(null);
              }}
            >
              Appliquer
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
