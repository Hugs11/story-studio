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
  {
    key: 'pause',
    label: 'Bouton Pause',
    onText: "L'enfant peut utiliser le bouton pause pendant l'histoire.",
    offText: "L'enfant ne peut pas utiliser le bouton pause pendant l'histoire.",
    def: false,
  },
];

const TITLE_CONTROLS = [
  { key: 'autoplay', label: "Lancer l'histoire automatiquement", tip: "L'histoire se lance toute seule à la fin de l'audio de sélection, sans attendre que l'enfant appuie sur OK.", def: false },
  { key: 'ok',       label: 'Bouton OK',            tip: "L'enfant peut appuyer sur OK pour lancer l'histoire.",                   def: true },
  { key: 'home',     label: 'Bouton Accueil',        tip: "L'enfant peut revenir au menu parent en appuyant sur le bouton Accueil.", def: true },
  { key: 'pause',    label: 'Bouton pause',          tip: "L'enfant peut mettre en pause l'audio de sélection.",                    def: false },
  { key: 'wheel',    label: 'Molette',              tip: "L'enfant peut tourner la molette pour parcourir les autres histoires.",   def: true },
];

let duringPlaySelectionAdvancedOpen = false;

export function DuringPlaySection({ node, project = null, allMenus = [], allStories = [], parentMenu = null, onUpdate }) {
  const [showAdvanced, setShowAdvanced] = useState(duringPlaySelectionAdvancedOpen);
  const controls = node.controlSettings ?? {};
  const titleControls = node.titleControlSettings ?? {};
  const homeDefaultTargetName = parentMenu?.name || "le menu d'accueil du pack";
  const endNodeBypassNote = hasVisibleEndNode(project)
    ? ' (sans passer par le message de fin)'
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
  const pauseEnabled = controls.pause ?? PLAY_CONTROLS[0].def;
  const homeEnabled = !node.returnOnHomeNone;

  return (
    <div className="card during-play-card">
      <div className="card-title">Pendant l'histoire</div>
      <div className="during-play-help">
        Choisis les boutons utilisables pendant la lecture de l'histoire.
      </div>

      <div className="during-play-stack">
        <div className="sequence-controls during-play-toggles">
          {PLAY_CONTROLS.map(({ key, label, onText, offText, def }) => (
            <label key={key} className="sequence-control">
              <Toggle
                on={controls[key] ?? def}
                onChange={(v) => onUpdate({ controlSettings: { ...controls, [key]: v } })}
                ariaLabel={label}
              />
              <Tooltip text={pauseEnabled ? onText : offText} placement="above" style={{ minWidth: 0 }}>
                <span className="during-play-control-title">{label}</span>
              </Tooltip>
            </label>
          ))}
        </div>

        <div className="during-play-home">
          <div className="sequence-control during-play-home-head">
            <Toggle
              on={homeEnabled}
              onChange={(v) => onUpdate({ returnOnHome: null, returnOnHomeNone: !v })}
              ariaLabel="Bouton Accueil"
            />
            <Tooltip
              text={homeEnabled
                ? "L'enfant peut appuyer sur le bouton Accueil pendant l'histoire."
                : "L'enfant ne peut pas appuyer sur le bouton Accueil pendant l'histoire."}
              placement="above"
              style={{ minWidth: 0 }}
            >
              <span className="during-play-control-title">Bouton Accueil</span>
            </Tooltip>
            {homeEnabled ? (
              <>
                <span className="during-play-destination-label">Au retour</span>
                <div className="during-play-home-select">
                  <NavigationTargetSelect
                    value={node.returnOnHome ?? ''}
                    onChange={(target) => onUpdate({ returnOnHome: target || null, returnOnHomeNone: false })}
                    allMenus={allMenus}
                    allStories={allStories}
                    currentStoryId={node.id}
                    emptyLabel={homeResolvedDestinationLabel || 'Retour vers la destination de lecture'}
                    includeRoot={false}
                    includeStoryPlay={false}
                    size="compact"
                    resolvedDestinationLabel={null}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`during-play-advanced-disclosure ${showAdvanced ? 'is-open' : ''}`}
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((v) => {
          const next = !v;
          duringPlaySelectionAdvancedOpen = next;
          return next;
        })}
      >
        <span className="during-play-advanced-chevron" aria-hidden="true">{showAdvanced ? '▾' : '▸'}</span>
        <span>Réglages avancés</span>
      </button>

      {showAdvanced && (
        <div className="during-play-advanced-panel">
          <div className="during-play-advanced-title">Écran de sélection</div>
          <div className="during-play-advanced-desc">
            Boutons actifs pendant l'audio de sélection, avant que l'histoire ne commence.
          </div>
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
