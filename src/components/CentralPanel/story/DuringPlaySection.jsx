import { useState } from 'react';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import { hasVisibleEndNode } from '../../../store/generatedNavigation';
import { getNavigationSelectHint, NavigationTargetSelect } from './storyUtils';

const TITLE_CONTROL_DEFAULTS = {
  autoplay: false,
  ok: true,
  home: true,
  pause: false,
  wheel: true,
};

const PLAY_CONTROLS = [
  { key: 'pause',    label: 'Pause',               tip: "L'enfant peut mettre l'histoire en pause en appuyant sur le bouton pause.",            def: false },
  { key: 'wheel',    label: 'Molette',              tip: "L'enfant peut tourner la molette pendant la lecture (par exemple pour changer d'histoire).", def: false },
];

const TITLE_CONTROLS = [
  { key: 'autoplay', label: "Lancer l'histoire automatiquement", tip: "L'histoire se lance toute seule à la fin de l'audio de sélection, sans attendre que l'enfant appuie sur OK.", def: false },
  { key: 'ok',       label: 'Bouton OK',            tip: "L'enfant peut appuyer sur OK pour lancer l'histoire.",                   def: true },
  { key: 'home',     label: 'Bouton Accueil',        tip: "L'enfant peut revenir au menu parent en appuyant sur le bouton Accueil.", def: true },
  { key: 'pause',    label: 'Bouton pause',          tip: "L'enfant peut mettre en pause l'audio de sélection.",                    def: false },
  { key: 'wheel',    label: 'Molette',              tip: "L'enfant peut tourner la molette pour parcourir les autres histoires.",   def: true },
];

export function DuringPlaySection({ node, project = null, allMenus = [], allStories = [], parentMenu = null, onUpdate }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const controls = node.controlSettings ?? {};
  const titleControls = node.titleControlSettings ?? {};
  const homeDefaultTargetName = parentMenu?.name || "le menu d'accueil du pack";
  const endNodeBypassNote = hasVisibleEndNode(project)
    ? ' (sans passer par le nœud de fin)'
    : '';
  const homeResolvedHint = `Retour direct vers ${homeDefaultTargetName}${endNodeBypassNote}`;
  const homeResolvedDestinationLabel = getNavigationSelectHint({
    value: node.returnOnHome ?? '',
    emptyResolvedLabel: homeResolvedHint,
    entry: node,
    parentMenu,
    project,
    allMenus,
    allStories,
  });

  return (
    <div className="card during-play-card">
      <div className="card-title">Pendant la lecture</div>

      <div className="during-play-split">
        <div className="during-play-left">
          <div className="sequence-controls during-play-toggles">
            {PLAY_CONTROLS.map(({ key, label, tip, def }) => (
              <label key={key} className="sequence-control">
                <Tooltip text={tip} placement="above" style={{ flex: 1 }}>
                  <span>{label}</span>
                </Tooltip>
                <Toggle
                  on={controls[key] ?? def}
                  onChange={(v) => onUpdate({ controlSettings: { ...controls, [key]: v } })}
                />
              </label>
            ))}
          </div>
        </div>

        <div className="during-play-divider" aria-hidden="true" />

        <div className="during-play-home">
          <div className="sequence-control during-play-home-head">
            <Tooltip
              text={node.returnOnHomeNone
                ? "Le bouton Accueil est désactivé pendant la lecture — l'enfant ne peut pas quitter l'histoire."
                : `Destination quand l'enfant appuie sur Accueil pendant la lecture. Par défaut : retour direct vers ${homeDefaultTargetName}${endNodeBypassNote}.`}
              placement="above"
              style={{ flex: 1 }}
            >
              <span>Accueil</span>
            </Tooltip>
            <Toggle
              on={!node.returnOnHomeNone}
              onChange={(v) => onUpdate({ returnOnHome: null, returnOnHomeNone: !v })}
            />
          </div>

          {!node.returnOnHomeNone ? (
            <NavigationTargetSelect
              value={node.returnOnHome ?? ''}
              onChange={(target) => onUpdate({ returnOnHome: target || null, returnOnHomeNone: false })}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              emptyLabel="Comportement par défaut"
              includeRoot={false}
              includeStoryPlay={false}
              size="compact"
              resolvedDestinationLabel={homeResolvedDestinationLabel}
            />
          ) : null}
        </div>
      </div>

      <div className="advanced-toggle-row">
        <div className="advanced-toggle-copy">
          <div className="field-label">Écran de sélection</div>
          <div className="advanced-toggle-desc">
            Boutons actifs pendant l'audio de sélection (avant que l'histoire ne se lance)
          </div>
        </div>
        <button
          type="button"
          className={`btn advanced-toggle-btn ${showAdvanced ? 'is-active' : ''}`}
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          Réglages avancés
        </button>
      </div>

      {showAdvanced && (
        <div style={{ marginTop: 10 }}>
          <div className="sequence-controls">
            {TITLE_CONTROLS.map(({ key, label, tip, def }) => (
              <label key={key} className="sequence-control">
                <Tooltip text={tip} placement="above">
                  <span style={{ flex: 1 }}>{label}</span>
                </Tooltip>
                <Toggle
                  on={titleControls[key] ?? TITLE_CONTROL_DEFAULTS[key] ?? def}
                  onChange={(v) => onUpdate({
                    titleControlSettings: { ...TITLE_CONTROL_DEFAULTS, ...titleControls, [key]: v },
                  })}
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
