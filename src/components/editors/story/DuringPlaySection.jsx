import { useTreeTranslation } from "../../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../../i18n/treePresentation.js";
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
    label: "tree:control.pause.title",
    onText: "tree:story.pause.enabled",
    offText: "tree:story.pause.disabled",
    def: false,
  },
];

const TITLE_CONTROLS = [
  { key: 'autoplay', label: "tree:story.titleAutoplay.label", tip: "tree:story.titleAutoplay.description", def: false },
  { key: 'ok',       label: "tree:control.ok.label",            tip: "tree:story.titleOk.description",                   def: true },
  { key: 'home',     label: "tree:control.home.label",        tip: "tree:story.titleHome.description", def: true },
  { key: 'pause',    label: "tree:control.pause.label",          tip: "tree:story.titlePause.description",                    def: false },
  { key: 'wheel',    label: "tree:control.wheel.label",              tip: "tree:story.titleWheel.description",   def: true },
];

// Valeur du sélecteur pour « Accueil sans destination » (`returnOnHomeNone`).
const HOME_PACK_START_VALUE = '__none__';

let duringPlaySelectionAdvancedOpen = false;

export function DuringPlaySection({ node, project = null, allMenus = [], allStories = [], parentMenu = null, onUpdate }) {
  useTreeTranslation();
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
  // Accueil sans destination : la Lunii revient à l'Écran d'entrée ; le
  // sélecteur le dit au lieu de proposer le dossier parent.
  const homeSelectValue = node.returnOnHome
    ?? (navigation.storyHome.isPackStart ? HOME_PACK_START_VALUE : null)
    ?? effectiveHomeSelectValue
    ?? parentMenuTarget
    ?? '';
  const includeHomeDefaultOption = !parentMenuTarget || homeSelectValue === '';

  return (
    <div className="card during-play-card">
      <div className="card-title-row">
        <div className="card-title">{t("tree:story.during.title")}</div>
        <div className="card-copy card-copy--inline">{t("tree:story.during.description")}</div>
      </div>

      <div className="during-play-stack">
        <div className="sequence-controls during-play-toggles">
          {PLAY_CONTROLS.map(({ key, label, onText, offText, def }) => (
            <label key={key} className="sequence-control">
              <Toggle
                on={controls[key] ?? def}
                onChange={(v) => onUpdate({ controlSettings: { ...controls, [key]: v } })}
                ariaLabel={t(label)}
              />
              <Tooltip text={t(pauseEnabled ? onText : offText)} placement="above" style={{ minWidth: 0 }}>
                <span className="during-play-control-title">{t(label)}</span>
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
              ariaLabel={t("tree:control.home.label")}
            />
            <Tooltip
              text={homeEnabled
                ? t("tree:story.home.enabled")
                : t("tree:story.home.disabled")}
              placement="above"
              style={{ minWidth: 0 }}
            >
              <span className="during-play-control-title">{t("tree:control.home.label")}</span>
            </Tooltip>
            {homeEnabled ? (
              <>
                <span className="during-play-destination-label">{t("tree:navigation.destination.label")}</span>
                <div className="during-play-home-select">
                  {navigation.storyHome.isEndHomeStep ? (
                    // La réaction Accueil de fin remplace toute destination
                    // choisie ici : le sélecteur n'aurait aucun effet.
                    <span className="card-copy">{t("tree:story.home.reactionInherited")}</span>
                  ) : (
                    <NavigationTargetSelect
                      value={homeSelectValue}
                      onChange={(target) => onUpdate(target === HOME_PACK_START_VALUE
                        ? { returnOnHome: null, returnOnHomeNone: true }
                        : { returnOnHome: target || null, returnOnHomeNone: false })}
                      allMenus={allMenus}
                      allStories={allStories}
                      currentStoryId={node.id}
                      emptyLabel={t("tree:story.home.returnMenu")}
                      includeDefault={includeHomeDefaultOption}
                      includeNone
                      includeStoryPlay={false}
                      size="compact"
                    />
                  )}
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
            <div className="story-advanced-title">{t("tree:story.selection.title")}</div>
            <div className="story-advanced-desc">{t("tree:story.selection.controlsDescription")}</div>
          </div>
        </div>
        <div className="story-advanced-controls">
          <div className="sequence-controls">
            {TITLE_CONTROLS.map(({ key, label, tip, def }) => (
              <label key={key} className="sequence-control">
                <Tooltip text={t(tip)} placement="above">
                  <span style={{ flex: 1 }}>{t(label)}</span>
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
                text={t("tree:story.selection.silentDescription")}
                placement="above"
              >
                <span style={{ flex: 1 }}>{t("tree:story.selection.silentLabel")}</span>
              </Tooltip>
              <Toggle
                on={silentSelectionEnabled}
                onChange={(enabled) => onUpdate(enabled
                  ? createSilentStoryTitleUpdate(node.titleControlSettings)
                  : { silentTitleStage: false })}
                ariaLabel={t("tree:story.selection.silentLabel")}
              />
            </label>
          </div>
        </div>
      </StoryDisclosure>
    </div>
  );
}
