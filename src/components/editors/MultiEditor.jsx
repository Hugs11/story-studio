import { TreeText, useTreeTranslation } from "../../i18n/useTreeTranslation.jsx";
import { presentTree, translateTree as t } from "../../i18n/treePresentation.js";
import { memo, useMemo, useState } from 'react';
import { Toggle } from '../common/Toggle';
import { Tooltip } from '../common/Tooltip';
import { findEntryById } from '../../store/projectModel';
import { useProjectContext } from '../../store/ProjectContext';
import { batchTitleVoice, isTtsAvailable } from '../../store/xttsSettings';
import { useErrorDialog } from '../common/Dialog';
import { generateTextImage } from '../TextImageGenerator/generateTextImage';
import { CircleStop, Moon, Pause, Sparkles, Speech, Trash2 } from '../icons/LucideLocal';
import {
  navigationTargetLabel,
  generatedTargetIdToSelectValue,
  NavigationTargetSelect,
} from './story/storyUtils';
import {
  getDefaultPackEntryDestination,
  getGeneratedStoryNavigation,
  summarizeEffectiveStoryEnds,
} from '../../store/generatedNavigation';
import { getGeneratedMenuControls } from '../../store/generatedPlayback';
import { isStoryNavigationTarget } from '../../store/navigationTargets';
import {
  canShowTextImageBatchAction,
  getTextImageBatchTargets,
} from './multiEditorBatchTargets';
import { TREE_COLOR_PALETTE } from '../tree/treeOperations';

const STORY_DEFAULTS = { autoplay: false, pause: true, wheel: false, home: true };
const MENU_DEFAULTS = { autoplay: false, pause: false, wheel: true };

const SHARED_DURING_CONTROL_KEYS = [
  { key: 'pause',    label: "tree:control.pause.title",         desc: "tree:multi.pause.description" },
];

const MENU_CONTROL_KEYS = [
  { key: 'wheel',    label: "tree:control.wheel.selection", desc: "tree:multi.wheel.description" },
  { key: 'autoplay', label: "tree:control.autoplay.label",  desc: "tree:multi.autoplay.description" },
  { key: 'pause',    label: "tree:control.pause.label",         desc: "tree:multi.titlePause.description" },
];

function getDefaults(type) {
  return type === 'menu' ? MENU_DEFAULTS : STORY_DEFAULTS;
}

export const MultiEditor = memo(function MultiEditor({
  selectedIds,
  project,
  projectIndex,
  allMenus,
  allStories,
  onBulkUpdateItems,
  onBulkDeleteItems,
}) {
  useTreeTranslation();
  const ids = useMemo(() => [...selectedIds], [selectedIds]);

  const nodes = useMemo(
    () => ids.map((id) => {
      if (id === 'root') {
        return {
          id: 'root',
          type: 'root',
          name: project?.rootName || project?.packMetadata?.title || project?.projectName || t("tree:navigation.root.label"),
        };
      }
      if (id === 'end-node') {
        return {
          id: 'end-node',
          type: 'end-node',
          name: project?.endNodeName || t("tree:endNode.card.title"),
        };
      }
      return findEntryById(project, id, projectIndex);
    }).filter(Boolean),
    [ids, project, projectIndex, t("tree:navigation.root.label")],
  );

  const {
    xttsSettings,
    onQueueXttsGenerate,
    onMediaCreated,
    savePath,
    workspaceDir,
    mediaStorage,
  } = useProjectContext();
  const { showErrorDialog } = useErrorDialog();
  const [batchImageGenerating, setBatchImageGenerating] = useState(false);
  const [batchAudioGenerating, setBatchAudioGenerating] = useState(false);
  const [batchError, setBatchError] = useState('');

  const editableNodes = nodes.filter((n) => n.type === 'story' || n.type === 'menu');
  const textImageNodes = getTextImageBatchTargets(nodes);
  const canGenerateTextImages = canShowTextImageBatchAction(nodes);
  const titleAudioNodes = nodes.filter((n) => (
    n.type === 'story'
    || n.type === 'menu'
    || n.type === 'root'
    || n.type === 'end-node'
  ));
  const editableIds = editableNodes.map((n) => n.id);
  const storyCount = nodes.filter((n) => n.type === 'story').length;
  const zipCount = nodes.filter((n) => n.type === 'zip').length;
  const menuCount = nodes.filter((n) => n.type === 'menu').length;
  const rootCount = nodes.filter((n) => n.type === 'root').length;
  const endNodeCount = nodes.filter((n) => n.type === 'end-node').length;
  const onlyStories = storyCount === nodes.length && storyCount > 0;
  const onlyMenus = menuCount === nodes.length && menuCount > 0;
  const allSameType = onlyStories || onlyMenus;
  const hasEndNode = !!project?.nightModeAudio || !!project?.globalOptions?.nightMode || !!project?.globalOptions?.endNode;
  const forcedLinearRootMenuIds = new Set(
    onlyMenus
      ? editableNodes
        .filter((entry) => getGeneratedMenuControls(entry, getParentMenu(entry), project).forceAutoplay)
        .map((entry) => entry.id)
      : [],
  );

  const bannerParts = [];
  if (storyCount > 0) bannerParts.push(t("tree:count.stories.label", { count: storyCount }));
  if (zipCount > 0) bannerParts.push(t("tree:count.archives.label", { count: zipCount }));
  if (menuCount > 0) bannerParts.push(t("tree:count.folders.label", { count: menuCount }));
  if (rootCount > 0) bannerParts.push(t("tree:multi.root.label"));
  if (endNodeCount > 0) bannerParts.push(project?.endNodeName || t("tree:multi.endNode.label"));

  function handleControlChange(key, value) {
    const targetIds = (key === 'wheel' || key === 'autoplay')
      ? editableIds.filter((id) => !forcedLinearRootMenuIds.has(id))
      : editableIds;
    onBulkUpdateItems(targetIds, (entry) => ({
      controlSettings: { ...entry.controlSettings, [key]: value },
    }));
  }

  const colorableIds = nodes
    .filter((n) => n.type === 'story' || n.type === 'menu' || n.type === 'zip')
    .map((n) => n.id);

  function getMixedColor() {
    const colors = nodes
      .filter((n) => n.type === 'story' || n.type === 'menu' || n.type === 'zip')
      .map((n) => n.treeColor ?? null);
    const unique = [...new Set(colors)];
    if (unique.length === 0) return null;
    if (unique.length === 1) return unique[0];
    return '__mixed__';
  }

  function handleSetColor(color) {
    if (colorableIds.length === 0) return;
    onBulkUpdateItems(colorableIds, () => ({ treeColor: color }));
  }

  function handleAutoBlackImageChange(value) {
    onBulkUpdateItems(
      editableNodes.filter((n) => n.type === 'menu').map((n) => n.id),
      () => ({ autoBlackImage: value }),
    );
  }

  function handleStoryAutoContinuationChange(value) {
    onBulkUpdateItems(editableIds, (entry) => ({
      controlSettings: {
        ...entry.controlSettings,
        autoplay: value,
        ok: !value,
      },
      ...(value ? {} : { returnAfterPlay: null }),
    }));
  }

  function handleNavChange(field, rawValue) {
    onBulkUpdateItems(editableIds, () => ({ [field]: rawValue || null }));
  }

  function getMixedSelectValue(field) {
    const vals = nodes.map((n) => n[field] ?? '');
    const unique = [...new Set(vals)];
    return unique.length === 1 ? unique[0] : '__mixed__';
  }

  function getParentMenu(entry) {
    const parentId = projectIndex?.parentMenuById?.get(entry.id) ?? null;
    return parentId ? projectIndex?.entryById?.get(parentId) ?? null : null;
  }

  function getHomeSelectValue(entry) {
    if (entry.returnOnHome) return entry.returnOnHome;
    const navigation = getGeneratedStoryNavigation(entry, getParentMenu(entry), project, project?.rootEntries ?? []);
    // Accueil sans destination : la Lunii revient à l'Écran d'entrée.
    if (navigation.storyHome.isPackStart) return '__none__';
    return generatedTargetIdToSelectValue(navigation.storyHome.effectiveTargetId);
  }

  function getEffectiveDestinationInfo(targetId) {
    if (!targetId) return null;
    if (targetId === 'root') {
      const destination = getDefaultPackEntryDestination(project);
      if (!destination) return { label: t("tree:navigation.root.label"), selectValue: null, kind: 'menu' };
      const generatedTargetId = destination.type === 'story'
        ? `story:${destination.id}`
        : destination.type === 'menu'
          ? destination.id
          : null;
      return {
        label: project?.rootEntries?.[0]?.name || t("tree:navigation.name.fallback"),
        selectValue: generatedTargetIdToSelectValue(generatedTargetId),
        kind: destination.type === 'story' ? 'story' : 'menu',
      };
    }
    return {
      label: navigationTargetLabel(targetId, projectIndex),
      selectValue: generatedTargetIdToSelectValue(targetId),
      kind: isStoryNavigationTarget(targetId) ? 'story' : 'menu',
    };
  }

  function getMixedBooleanValue(values) {
    const unique = [...new Set(values)];
    return {
      isMixed: unique.length > 1,
      value: unique.length > 1 ? false : !!unique[0],
    };
  }

  const storyAfterPlaySummary = onlyStories
    ? summarizeEffectiveStoryEnds(
      editableNodes,
      getParentMenu,
      project,
      project?.rootEntries ?? [],
    )
    : null;
  const storyAfterPlayDestination = getEffectiveDestinationInfo(
    storyAfterPlaySummary?.commonFinalTargetId,
  );
  const storyReturnAfterPlayValue = onlyStories
    ? getMixedSelectValue('returnAfterPlay')
    : '__mixed__';
  const storyReturnEmptyLabel = storyAfterPlayDestination?.label
    || (storyAfterPlaySummary?.hasDifferentDestinations
      ? t("tree:navigation.storySpecific.label")
      : t("tree:navigation.storyDefault.label"));
  const usesStorySpecificEndReturn = onlyStories && hasEndNode && !project?.nightModeReturn;

  const batchBusy = batchImageGenerating || batchAudioGenerating;
  const playbackControlKeys = onlyMenus ? MENU_CONTROL_KEYS : SHARED_DURING_CONTROL_KEYS;
  const playbackControlTitle = onlyMenus ? t("tree:multi.menu.title") : t("tree:story.during.title");
  const batchGenerationDescription = canGenerateTextImages
    ? t("tree:multi.generation.description")
    : t("tree:multi.generation.audioDescription");

  function getNodeTitle(node) {
    return (node.name && node.name.trim()) ? node.name.trim() : t("tree:story.title.fallback");
  }

  async function handleGenerateTextImagesFromNames() {
    if (batchBusy) return;
    setBatchError('');
    setBatchImageGenerating(true);
    const imageUpdates = new Map();
    const errors = [];

    try {
      for (const node of textImageNodes) {
        const text = getNodeTitle(node);
        const isMenu = node.type === 'menu';

        try {
          const imagePath = await generateTextImage(text, workspaceDir, { mediaStorage });
          if (imagePath) {
            onMediaCreated?.(imagePath);
            imageUpdates.set(
              node.id,
              isMenu
                ? { image: imagePath, autoGenerateImage: false }
                : { itemImage: imagePath, autoGenerateImage: false },
            );
          }
        } catch {
          errors.push({ key: "tree:multi.image.failed", params: { name: text } });
        }
      }

      if (imageUpdates.size > 0) {
        onBulkUpdateItems(
          [...imageUpdates.keys()],
          (entry) => imageUpdates.get(entry.id) || {},
        );
      }

      if (errors.length > 0) {
        setBatchError(errors);
      }
    } finally {
      setBatchImageGenerating(false);
    }
  }

  async function handleGenerateTitleAudiosFromNames() {
    if (batchBusy) return;
    setBatchError('');

    const voice = batchTitleVoice(xttsSettings);
    if (!voice) {
      const msg = { key: "tree:multi.voice.required" };
      setBatchError(msg);
      showErrorDialog({
        title: <TreeText messageKey="tree:multi.audio.title" />,
        message: msg,
        variant: 'warning',
      });
      return;
    }

    setBatchAudioGenerating(true);
    const errors = [];

    try {
      for (const node of titleAudioNodes) {
        const text = getNodeTitle(node);
        const isMenu = node.type === 'menu';
        const target = (() => {
          if (node.type === 'root') return { kind: 'root', field: 'rootAudio' };
          if (node.type === 'end-node') return { kind: 'root', field: 'nightModeAudio' };
          if (isMenu) return { kind: 'menu', entryId: node.id, field: 'audio' };
          return { kind: 'story', entryId: node.id, field: 'itemAudio' };
        })();
        // La requête garde le texte choisi ; le repli de destination reste vivant.
        const targetName = node.type === 'root' && !(project?.rootName || project?.packMetadata?.title || project?.projectName)
          ? { key: "tree:navigation.root.label" }
          : node.type === 'end-node' && !project?.endNodeName
            ? { key: "tree:endNode.card.title" }
            : node.name?.trim() ? text : { key: "tree:story.title.fallback" };
        try {
          await onQueueXttsGenerate?.({
            target,
            targetLabelRef: { key: "tree:multi.voice.target", params: { name: targetName } },
            voiceLabel: voice,
            request: {
              text,
              language: xttsSettings?.language || 'fr',
              speaker: null,
              voice,
              savePath,
              // eslint-disable-next-line i18next/no-literal-string -- préfixe technique de fichier généré
              filenameHint: `selection-${text}`,
            },
          });
        } catch {
          errors.push({ key: "tree:multi.audio.failed", params: { name: text } });
        }
      }

      if (errors.length > 0) {
        setBatchError(errors);
      }
    } finally {
      setBatchAudioGenerating(false);
    }
  }

  if (nodes.length === 0) return null;

  return (
    <>
      {(canGenerateTextImages || titleAudioNodes.length > 0) && (
        <div className="card">
          <div className="card-title-row">
            <div className="card-title">{t("tree:multi.generation.title")}</div>
          </div>
          <div className="editor-setting-row is-action-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">{t("tree:multi.names.generate")}</div>
              <div className="editor-setting-desc">
                {batchGenerationDescription}
              </div>
            </div>
            <div className="editor-setting-actions">
              {canGenerateTextImages ? (
                <button
                  type="button"
                  className="batch-generate-btn"
                  onClick={handleGenerateTextImagesFromNames}
                  disabled={batchBusy}
                >
                  <Sparkles className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  {batchImageGenerating ? t("tree:multi.image.progress") : t("tree:multi.image.action")}
                </button>
              ) : null}
              {isTtsAvailable(xttsSettings) && titleAudioNodes.length > 0 && (
                <button
                  type="button"
                  className="batch-generate-btn"
                  onClick={handleGenerateTitleAudiosFromNames}
                  disabled={batchBusy}
                >
                  <Speech className="batch-generate-btn-icon" strokeWidth={2} absoluteStrokeWidth />
                  {batchAudioGenerating ? t("tree:multi.audio.progress") : t("tree:multi.titles.audio")}
                </button>
              )}
            </div>
          </div>
          {batchError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>
              {presentTree(batchError)}
            </div>
          )}
        </div>
      )}

      {editableNodes.length > 0 && (
        onlyStories ? (() => {
          const pauseState = getMixedBooleanValue(
            editableNodes.map((n) => n.controlSettings?.pause ?? STORY_DEFAULTS.pause),
          );
          const homeState = getMixedBooleanValue(
            editableNodes.map((n) => n.controlSettings?.home ?? STORY_DEFAULTS.home),
          );
          const homeSelectValues = editableNodes.map(getHomeSelectValue);
          const homeSelectUnique = [...new Set(homeSelectValues)];
          const homeSelectValue = homeSelectUnique.length === 1 ? homeSelectUnique[0] : '__mixed__';
          const showHomeDestination = homeState.isMixed || homeState.value;

          return (
            <div className="card during-play-card">
              <div className="card-title-row">
                <div className="card-title">{t("tree:story.during.title")}</div>
                <div className="card-copy card-copy--inline">{t("tree:story.during.description")}</div>
              </div>

              <div className="during-play-stack">
                <div className="sequence-controls during-play-toggles">
                  <label className="sequence-control">
                    <Toggle
                      on={pauseState.value}
                      mixed={pauseState.isMixed}
                      onChange={(v) => handleControlChange('pause', v)}
                      ariaLabel={t("tree:control.pause.title")}
                    />
                    <Tooltip
                      text={pauseState.isMixed
                        ? t("tree:multi.control.mixed")
                        : pauseState.value
                          ? t("tree:story.pause.enabled")
                          : t("tree:story.pause.disabled")}
                      placement="above"
                      style={{ minWidth: 0 }}
                    >
                      <span className="during-play-control-title">{t("tree:control.pause.title")}</span>
                    </Tooltip>
                  </label>
                </div>

                <div className="during-play-home">
                  <div className="sequence-control during-play-home-head">
                    <Toggle
                      on={homeState.value}
                      mixed={homeState.isMixed}
                      onChange={(v) => {
                        onBulkUpdateItems(editableIds, (entry) => ({
                          controlSettings: { ...entry.controlSettings, home: v },
                          ...(v ? {} : { returnOnHome: null, returnOnHomeNone: true }),
                        }));
                      }}
                      ariaLabel={t("tree:control.home.label")}
                    />
                    <Tooltip
                      text={homeState.isMixed
                        ? t("tree:multi.control.mixed")
                        : homeState.value
                          ? t("tree:story.home.enabled")
                          : t("tree:story.home.disabled")}
                      placement="above"
                      style={{ minWidth: 0 }}
                    >
                      <span className="during-play-control-title">{t("tree:control.home.label")}</span>
                    </Tooltip>
                    {showHomeDestination ? (
                      <>
                        <span className="during-play-destination-label">{t("tree:navigation.destination.label")}</span>
                        <div className="during-play-home-select">
                          <NavigationTargetSelect
                            value={homeSelectValue}
                            onChange={(target) => {
                              if (target === '__mixed__') return;
                              onBulkUpdateItems(editableIds, () => (target === '__none__'
                                ? { returnOnHome: null, returnOnHomeNone: true }
                                : { returnOnHome: target || null, returnOnHomeNone: false }));
                            }}
                            allMenus={allMenus}
                            allStories={allStories.filter((s) => !ids.includes(s.id))}
                            currentStoryId={null}
                            emptyLabel={t("tree:navigation.parent.direct")}
                            includeNone
                            includeStoryPlay={false}
                            size="compact"
                          />
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })() : (
      <div className="card">
        <div className="card-title-row">
          <div className="card-title">{playbackControlTitle}</div>
        </div>
        {forcedLinearRootMenuIds.size > 0 ? (
          <div className="info-box menu-behavior-info">{t("tree:multi.linear.description")}</div>
        ) : null}
        <div className="editor-setting-stack">
        {onlyMenus && (() => {
          const vals = editableNodes.map((n) => !!n.autoBlackImage);
          const unique = [...new Set(vals)];
          const isMixed = unique.length > 1;
          const value = isMixed ? false : unique[0];
          return (
            <div className="editor-setting-row is-toggle-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">{t("tree:multi.image.none")}</div>
                <div className="editor-setting-desc">{t("tree:multi.image.description")}</div>
              </div>
              <div className="editor-setting-control">
                <Toggle
                  on={value}
                  mixed={isMixed}
                  onChange={(v) => handleAutoBlackImageChange(v)}
                />
              </div>
            </div>
          );
        })()}
        {playbackControlKeys.map(({ key, label, desc }) => {
          const controlNodes = (key === 'wheel' || key === 'autoplay')
            ? editableNodes.filter((entry) => !forcedLinearRootMenuIds.has(entry.id))
            : editableNodes;
          const vals = controlNodes.map((n) => n.controlSettings?.[key] ?? getDefaults(n.type)[key] ?? false);
          const unique = [...new Set(vals)];
          const isMixed = unique.length > 1;
          const value = isMixed ? false : unique[0];

          return (
            <div key={key} className="editor-setting-row is-toggle-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">{t(label)}</div>
                <div className="editor-setting-desc">{t(desc)}</div>
              </div>
              <div className="editor-setting-control">
                <Toggle
                  on={value}
                  mixed={isMixed}
                  onChange={(v) => handleControlChange(key, v)}
                />
              </div>
            </div>
          );
        })}
        {onlyStories && (
          <div className="editor-setting-row">
            <div className="editor-setting-copy">
              <div className="editor-setting-title">{t("tree:control.home.label")}</div>
              <div className="editor-setting-desc">{t("tree:multi.home.description")}</div>
            </div>
            <div className="editor-setting-control">
              <NavigationTargetSelect
                value={getMixedSelectValue('returnOnHome')}
                onChange={(target) => {
                  if (target === '__mixed__') return;
                  handleNavChange('returnOnHome', target);
                }}
                allMenus={allMenus}
                allStories={allStories.filter((s) => !ids.includes(s.id))}
                currentStoryId={null}
                emptyLabel={t("tree:navigation.parent.direct")}
                includeStoryPlay={false}
              />
            </div>
          </div>
        )}
        </div>
      </div>
        )
      )}

      {allSameType && hasEndNode && (onlyStories || onlyMenus) && (
        onlyStories ? (
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">{t("tree:playback.after.title")}</div>
              <div className="card-copy card-copy--inline">{t("tree:multi.after.description")}</div>
            </div>

            <div className="after-play-route">
              <div className="after-play-route-head">
                <div className="after-play-route-title">{t("tree:story.route.title")}</div>
              </div>
              <div className="after-play-route-list">
                <span className="after-play-route-chip">
                  <span className="after-play-route-icon"><CircleStop strokeWidth={2} absoluteStrokeWidth /></span>
                  <span>{t("tree:multi.route.finished")}</span>
                </span>
                <span className="after-play-route-arrow" aria-hidden="true">→</span>
                <span className="after-play-route-chip">
                  <span className="after-play-route-icon"><Moon strokeWidth={2} absoluteStrokeWidth /></span>
                  <span>{project?.globalOptions?.nightMode ? t("tree:multi.message.night", { name: project?.endNodeName || t("tree:endNode.card.title") }) : (project?.endNodeName || t("tree:endNode.card.title"))}</span>
                </span>
                <span className="after-play-route-arrow" aria-hidden="true">→</span>
                <span className="after-play-route-chip is-destination">
                  <span>
                    {usesStorySpecificEndReturn
                      ? (storyAfterPlayDestination?.label
                        || (storyAfterPlaySummary?.hasDifferentDestinations
                          ? t("tree:navigation.individual.label")
                          : t("tree:navigation.storyDefault.label")))
                      : t("tree:multi.route.messageDestination")}
                  </span>
                </span>
              </div>
            </div>

            <div className="after-play-destination-row">
              <div className="after-play-destination-copy">
                <span className="field-label">
                  {usesStorySpecificEndReturn
                    ? t("tree:story.destination.afterMessage")
                    : t("tree:multi.message.shared")}
                </span>
                <div className="after-play-muted">
                  {usesStorySpecificEndReturn
                    ? t("tree:multi.message.individual")
                    : t("tree:multi.message.description")}
                </div>
              </div>
              {usesStorySpecificEndReturn ? (
                <div className="after-play-destination-select">
                  <NavigationTargetSelect
                    value={storyReturnAfterPlayValue}
                    onChange={(target) => {
                      if (target === '__mixed__') return;
                      handleNavChange('returnAfterPlay', target);
                    }}
                    allMenus={allMenus}
                    allStories={allStories.filter((story) => !ids.includes(story.id))}
                    currentStoryId={null}
                    emptyLabel={storyReturnEmptyLabel}
                    resolvedDefaultValue={storyAfterPlayDestination?.selectValue}
                    resolvedDefaultLabel={storyAfterPlayDestination?.label}
                    resolvedDefaultKind={storyAfterPlayDestination?.kind}
                    hideDefaultWhenResolved
                  />
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">{t("tree:playback.after.title")}</div>
            </div>
            <div className="editor-setting-row is-note-row">
              <Moon className="editor-setting-icon" />
              <div className="editor-setting-copy">
                <div className="editor-setting-title">{t("tree:multi.message.managed")}</div>
                <div className="editor-setting-desc">{t("tree:multi.message.managedDescription")}</div>
              </div>
            </div>
          </div>
        )
      )}

      {allSameType && !hasEndNode && (allMenus.length > 0 || onlyStories) && (
        onlyStories ? (() => {
            const {
              isMixed,
              autoContinuation: value,
              showDestination,
              hasDifferentDestinations,
            } = storyAfterPlaySummary;

            return (
              <div className="card">
                <div className="card-title-row">
                  <div className="card-title">{t("tree:playback.after.title")}</div>
                  <div className="card-copy card-copy--inline">{t("tree:multi.after.description")}</div>
                </div>

                <div className="after-play-main-row">
                  <div className="after-play-end-row">
                    <span className="after-play-end-label">{t("tree:story.end.label")}</span>
                    <div className="story-end-mode" role="group" aria-label={t("tree:multi.end.aria")}>
                      <button
                        type="button"
                        className={`story-end-mode-btn ${!isMixed && !value ? 'is-active' : ''}`}
                        aria-pressed={!isMixed && !value}
                        onClick={() => handleStoryAutoContinuationChange(false)}
                      >{t("tree:story.end.stay")}</button>
                      <button
                        type="button"
                        className={`story-end-mode-btn ${!isMixed && value ? 'is-active' : ''}`}
                        aria-pressed={!isMixed && value}
                        onClick={() => handleStoryAutoContinuationChange(true)}
                      >{t("tree:story.end.continue")}</button>
                    </div>
                  </div>
                </div>

                <div className="after-play-route">
                  <div className="after-play-route-head">
                    <div className="after-play-route-title">{t("tree:story.route.title")}</div>
                    {isMixed ? <div className="after-play-route-context">{t("tree:multi.end.mixed")}</div> : null}
                  </div>
                  <div className="after-play-route-list">
                    <span className="after-play-route-chip">
                      <span className="after-play-route-icon"><CircleStop strokeWidth={2} absoluteStrokeWidth /></span>
                      <span>{t("tree:multi.route.finished")}</span>
                    </span>
                    <span className="after-play-route-arrow" aria-hidden="true">→</span>
                    {isMixed ? (
                      <span className="after-play-route-chip is-destination">
                        <span>{t("tree:navigation.individual.label")}</span>
                      </span>
                    ) : value ? (
                      <span className="after-play-route-chip is-destination">
                        <span>
                          {storyAfterPlayDestination?.label
                            || (hasDifferentDestinations
                              ? t("tree:navigation.storySpecific.label")
                              : t("tree:navigation.storyDefault.label"))}
                        </span>
                      </span>
                    ) : (
                      <span className="after-play-route-chip">
                        <span className="after-play-route-icon"><Pause strokeWidth={2} absoluteStrokeWidth /></span>
                        <span>{t("tree:story.route.waiting")}</span>
                      </span>
                    )}
                  </div>
                </div>

                {showDestination && (
                  <div className="after-play-destination-row">
                    <div className="after-play-destination-copy">
                      <span className="field-label">{t("tree:story.destination.afterStory")}</span>
                      <div className="after-play-muted">{t("tree:story.destination.description")}</div>
                    </div>
                    <div className="after-play-destination-select">
                      <NavigationTargetSelect
                        value={storyReturnAfterPlayValue}
                        onChange={(target) => {
                          if (target === '__mixed__') return;
                          handleNavChange('returnAfterPlay', target);
                        }}
                        allMenus={allMenus}
                        allStories={allStories.filter((s) => !ids.includes(s.id))}
                        currentStoryId={null}
                        emptyLabel={storyReturnEmptyLabel}
                        resolvedDefaultValue={storyAfterPlayDestination?.selectValue}
                        resolvedDefaultLabel={storyAfterPlayDestination?.label}
                        resolvedDefaultKind={storyAfterPlayDestination?.kind}
                        hideDefaultWhenResolved
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })() : (
          <div className="card">
            <div className="card-title-row">
              <div className="card-title">{t("tree:playback.after.title")}</div>
            </div>
            <div className="editor-setting-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">{t("tree:multi.destination.title")}</div>
                <div className="editor-setting-desc">{t("tree:multi.destination.description")}</div>
              </div>
              <div className="editor-setting-control">
                <NavigationTargetSelect
                  value={getMixedSelectValue('returnAfterPlay')}
                  onChange={(target) => {
                    if (target === '__mixed__') return;
                    handleNavChange('returnAfterPlay', target);
                  }}
                  allMenus={allMenus}
                  allStories={allStories.filter((s) => !ids.includes(s.id))}
                  currentStoryId={null}
                  emptyLabel={t("tree:navigation.parent.follow")}
                />
              </div>
            </div>
          </div>
        )
      )}

      {!allSameType && (
        <div className="multiselect-mixed-note">{t("tree:multi.selection.mixed")}</div>
      )}

      {colorableIds.length > 0 && (() => {
        const currentColor = getMixedColor();
        return (
          <div className="card">
            <div className="editor-setting-row is-action-row">
              <div className="editor-setting-copy">
                <div className="editor-setting-title">{t("tree:multi.color.label")}</div>
                <div className="editor-setting-desc">
                  {currentColor === '__mixed__'
                    ? t("tree:multi.color.mixed", { count: colorableIds.length })
                    : t("tree:multi.color.description", { count: colorableIds.length })}
                </div>
              </div>
              <div className="multiselect-color-dots">
                {TREE_COLOR_PALETTE.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`ctx-color-dot${currentColor === color ? ' is-active' : ''}`}
                    style={{ backgroundColor: color }}
                    title={color}
                    onClick={() => handleSetColor(color)}
                  />
                ))}
                <button
                  type="button"
                  className={`ctx-color-clear${currentColor === null ? ' is-active' : ''}`}
                  title={currentColor === '__mixed__' ? t("tree:multi.color.clearMixed") : t("tree:multi.color.none")}
                  onClick={() => handleSetColor(null)}
                >
                  ×
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <div className="card card--danger card--danger-compact">
        <div className="card-danger-row">
          <button
            className="card-danger-trash"
            type="button"
            onClick={() => onBulkDeleteItems?.(ids)}
            aria-label={t("tree:multi.delete.action")}
          >
            <Trash2 className="card-danger-icon" />
          </button>
          <span className="card-danger-title">{t("tree:multi.delete.action")}</span>
          <p className="card-danger-desc">
            {t("tree:multi.delete.description", { count: nodes.length, items: bannerParts.join(", ") })}
          </p>
        </div>
      </div>
    </>
  );
});
