import { useState } from 'react';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import { encodeMenuNavigationTarget } from '../../../store/navigationTargets';
import { getGeneratedStoryNavigation } from '../../../store/generatedNavigation';
import { generatedTargetIdToSelectValue, NavigationTargetSelect } from './storyUtils';
import { StoryDisclosure } from './StoryDisclosure';
import {
  createSilentStoryTitleUpdate,
  isExplicitSilentStoryTitle,
  TITLE_CONTROL_DEFAULTS,
} from '../../../store/storyTitleStage';

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
  const navigation = getGeneratedStoryNavigation(node, parentMenu, project, project?.rootEntries ?? []);
  const parentMenuTarget = parentMenu?.id ? encodeMenuNavigationTarget(parentMenu.id) : null;
  const pauseEnabled = controls.pause ?? PLAY_CONTROLS[0].def;
  const homeEnabled = controls.home ?? true;
  const silentSelectionEnabled = isExplicitSilentStoryTitle(node);
  const effectiveHomeSelectValue = navigation.storyHome.effectiveTargetId
    ? generatedTargetIdToSelectValue(navigation.storyHome.effectiveTargetId)
    : null;
  const homeSelectValue = node.returnOnHome ?? effectiveHomeSelectValue ?? parentMenuTarget ?? '';
  const includeHomeDefaultOption = !parentMenuTarget || homeSelectValue === '';

  return (
    <div className="card during-play-card">
      <div className="card-title-row">
        <div className="card-title">Pendant l'histoire</div>
        <div className="card-copy card-copy--inline">
          Choisis les boutons utilisables pendant la lecture de l'histoire.
        </div>
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
              onChange={(v) => onUpdate({
                controlSettings: { ...controls, home: v },
                ...(v ? {} : { returnOnHome: null, returnOnHomeNone: true }),
              })}
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
                <span className="during-play-destination-label">Destination</span>
                <div className="during-play-home-select">
                  <NavigationTargetSelect
                    value={homeSelectValue}
                    onChange={(target) => onUpdate({ returnOnHome: target || null, returnOnHomeNone: false })}
                    allMenus={allMenus}
                    allStories={allStories}
                    currentStoryId={node.id}
                    emptyLabel="Retour au menu d'accueil"
                    includeDefault={includeHomeDefaultOption}
                    includeStoryPlay={false}
                    size="compact"
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <StoryDisclosure
        open={showAdvanced}
        onToggle={() => setShowAdvanced((v) => {
          const next = !v;
          duringPlaySelectionAdvancedOpen = next;
          return next;
        })}
      >
        <div className="story-advanced-row">
          <div className="story-advanced-copy">
            <div className="story-advanced-title">Écran de sélection</div>
            <div className="story-advanced-desc">
              Boutons actifs pendant l'audio de sélection, avant que l'histoire ne commence.
            </div>
          </div>
        </div>
        <div className="story-advanced-controls">
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
            <label className="sequence-control">
              <Tooltip
                text="Ne joue aucun audio de sélection avant le lancement de l'histoire."
                placement="above"
              >
                <span style={{ flex: 1 }}>Écran de sélection silencieux</span>
              </Tooltip>
              <Toggle
                on={silentSelectionEnabled}
                onChange={(enabled) => onUpdate(enabled
                  ? createSilentStoryTitleUpdate(node.titleControlSettings)
                  : { silentTitleStage: false })}
                ariaLabel="Écran de sélection silencieux"
              />
            </label>
          </div>
        </div>
      </StoryDisclosure>
    </div>
  );
}
