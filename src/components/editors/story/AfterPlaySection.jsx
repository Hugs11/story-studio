import { Trans } from 'react-i18next';
import { TreeText, useTreeTranslation } from "../../../i18n/useTreeTranslation.jsx";
import { translateTree as t } from "../../../i18n/treePresentation.js";
import { useEffect, useRef, useState } from 'react';
import { AudioField } from '../AudioField';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import { Button } from '../../common/Button';
import {
  encodeStoryNavigationTarget,
  decodeNavigationStoryId,
  isCurrentMenuNavigationTarget,
  isNextStoryNavigationTarget,
  isRootNavigationTarget,
  isStoryHomeStepNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
} from '../../../store/navigationTargets';
import {
  getDefaultPackEntryDestination,
  getEffectiveEndBehavior,
} from '../../../store/generatedNavigation';
import {
  packStartReturnLabel,
  CONTROL_DEFS,
  SEQUENCE_CONTROL_DEFAULTS,
  NavigationTargetSelect,
  generatedTargetIdToSelectValue,
  getNavigationSelectHint,
  NAV_ROOT_LABEL,
  normalizeSequenceStep,
} from './storyUtils';
import { EndSequenceEditor } from './EndSequenceEditor';
import { StoryDisclosure } from './StoryDisclosure';
import { ChevronDown, ChevronUp, CircleStop, Pause, Trash2 } from '../../icons/LucideLocal';
import { NodeIcon } from '../../icons/NodeIcon.jsx';
import { hierarchicalNatureOf } from '../../../store/nodeIconVocabulary.js';
import { WORKSPACE_MODE_HIERARCHICAL } from '../../../store/projectWorkState.js';
import { useErrorDialog } from '../../common/Dialog';
import { useProjectActions } from '../../../store/ProjectActionsContext';
import { useProjectContext } from '../../../store/ProjectContext';
import { pickAudio } from '../../../hooks/useFileDialog';
import { basename } from '../../../utils/fileUtils';
import {
  createLocalEndDraft,
  getLocalEndDraftApplicability,
  materializeLocalEndDraftFields,
  selectLocalEndDraftAudio,
} from '../../../store/localEndDraft';

function destinationHintLabel(label) {
  if (!label) return null;
  return String(label)
    .replace(/^Retour vers /, '')
    .replace(/^Lecture de /, '')
    .trim();
}

function RouteChip({ icon = null, children, destination = false }) {
  useTreeTranslation();
  return (
    <span className={`after-play-route-chip${destination ? ' is-destination' : ''}`}>
      {icon ? <span className="after-play-route-icon">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}

function RouteArrow() {
  useTreeTranslation();
  return <span className="after-play-route-arrow" aria-hidden="true">→</span>;
}

function RouteTargetIcon({ type, nightMode = false }) {
  useTreeTranslation();
  // Une cible de navigation est toujours nommee a cote de son dessin. Le repli
  // est le Dossier.
  return (
    <NodeIcon
      workspaceMode={WORKSPACE_MODE_HIERARCHICAL}
      nature={hierarchicalNatureOf(type, { night: nightMode }) ?? 'menu'}
    />
  );
}

function routeTypeFromTarget(target, project) {
  if (!target) return 'menu';
  if (isStoryNavigationTarget(target) || isNextStoryNavigationTarget(target)) return 'story';
  if (isRootNavigationTarget(target)) {
    return getDefaultPackEntryDestination(project)?.type || 'root';
  }
  return 'menu';
}

function routeDestinationFromTarget(targetId, project, allMenus, allStories) {
  if (!targetId) return null;
  if (targetId === 'root') {
    const defaultDest = getDefaultPackEntryDestination(project);
    if (!defaultDest) return { name: t(NAV_ROOT_LABEL), type: 'menu' };
    return { name: project?.rootEntries?.[0]?.name || t("tree:navigation.name.fallback"), type: defaultDest.type };
  }
  if (isStoryNavigationTarget(targetId)) {
    const storyId = decodeNavigationStoryId(targetId);
    const story = allStories.find((s) => s.id === storyId);
    const name = story?.name ?? t("tree:story.type.label");
    return { name: isStoryPlayNavigationTarget(targetId) ? t("tree:navigation.story.direct", { name }) : isStoryHomeStepNavigationTarget(targetId) ? t("tree:navigation.story.endReturn", { name }) : name, type: "story" };
  }
  const menu = allMenus.find((m) => m.id === targetId);
  return menu ? { name: menu.name, type: 'menu' } : null;
}

function resolvedReturnSelectValueFromTarget(targetId, project) {
  if (!targetId) return null;
  if (isRootNavigationTarget(targetId)) {
    const defaultDest = getDefaultPackEntryDestination(project);
    if (!defaultDest?.id) return null;
    if (defaultDest.type === 'story') return encodeStoryNavigationTarget(defaultDest.id);
    if (defaultDest.type === 'menu') return generatedTargetIdToSelectValue(defaultDest.id);
    return null;
  }
  return generatedTargetIdToSelectValue(targetId);
}

function getAutoNextContextText(autoNextResolution) {
  if (!autoNextResolution?.enabled) return null;
  if (autoNextResolution.applies) {
    return autoNextResolution.hasNextStory
      ? t("tree:story.autoNext.nextDescription")
      : t("tree:story.autoNext.lastDescription");
  }
  return null;
}

export function AfterPlaySection({
  node,
  parentMenu,
  allMenus,
  allStories,
  project,
  inheritedReturnLabel,
  inheritedReturnKind = null,
  onUpdate,
  afterPlayFocus = null,
  onAfterPlayFocusConsumed,
}) {
  useTreeTranslation();
  const { showConfirmDialog } = useErrorDialog();
  const { onAttachStoryEndToGlobal } = useProjectActions();
  const { onImportFile } = useProjectContext();
  const autoNextEnabled = !!project?.globalOptions?.autoNext;
  const startReturnLabel = packStartReturnLabel(project);
  const hasEndNode = !!(!autoNextEnabled && (project?.nightModeAudio || project?.globalOptions?.nightMode || project?.globalOptions?.endNode));
  const rawHasPrompt = !!node?.afterPlaybackPromptAudio;
  const hasPrompt = rawHasPrompt && !autoNextEnabled;
  const afterPlaybackSequence = node.afterPlaybackSequence ?? [];
  const afterPlaybackHomeStep = node.afterPlaybackHomeStep
    ? normalizeSequenceStep(node.afterPlaybackHomeStep, 0)
    : null;

  const rawHasSequence = afterPlaybackSequence.length > 0;
  const hasSequence = rawHasSequence && !autoNextEnabled;
  const effectiveEndBehavior = node?.type === 'story'
    ? getEffectiveEndBehavior(node, parentMenu, project, project?.rootEntries ?? [])
    : null;
  const storyNavigation = effectiveEndBehavior?.navigation ?? null;
  // Même audio ne suffit pas : une histoire peut réutiliser le son global tout
  // en envoyant vers une autre destination. Le moteur de navigation est la
  // source de vérité pour qualifier un message comme global importé.
  const endMessage = storyNavigation?.endMessage ?? { presentationKind: 'none' };
  const usesGlobalEndNodeAudio = endMessage.presentationKind === 'global';
  const hasGeneratedEndNode = usesGlobalEndNodeAudio;
  const usesStorySpecificEndReturn = hasGeneratedEndNode && !project?.nightModeReturn;
  const autoNextResolution = effectiveEndBehavior?.autoNext ?? null;
  const autoNextApplies = !!autoNextResolution?.applies;

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSequenceEditor, setShowSequenceEditor] = useState(false);
  const [showPromptField, setShowPromptField] = useState(false);
  const [localDraft, setLocalDraft] = useState(null);
  const afterPlayRef = useRef(null);
  const focusRequestId = afterPlayFocus?.requestId;

  useEffect(() => {
    if (!focusRequestId || afterPlayFocus?.storyId !== node.id) return;
    setShowAdvanced(true);
    setShowSequenceEditor(hasSequence);
    setShowPromptField(hasPrompt);
    requestAnimationFrame(() => {
      afterPlayRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    onAfterPlayFocusConsumed?.();
  }, [afterPlayFocus?.storyId, focusRequestId, hasPrompt, hasSequence, node.id, onAfterPlayFocusConsumed]);

  const promptControls = node.afterPlaybackPromptControlSettings ?? {};
  const storyControls = node.controlSettings ?? {};
  const autoContinuationEnabled = !!effectiveEndBehavior?.autoContinuation;
  const routeFinalTargetId = effectiveEndBehavior?.finalTargetId ?? null;
  const routeFinalDestination = routeDestinationFromTarget(routeFinalTargetId, project, allMenus, allStories);
  const returnIsVirtualTarget = isRootNavigationTarget(node.returnAfterPlay)
    || isCurrentMenuNavigationTarget(node.returnAfterPlay);
  // On résout l'affichage vers la destination réelle dans deux cas : le retour par
  // défaut d'une histoire racine (elle atterrit sur sa propre vignette) et tout retour
  // « virtuel » (racine / dossier courant) qui n'a pas de ligne dédiée dans la liste.
  const resolvedReturnTargetId = ((!node.returnAfterPlay && !parentMenu) || returnIsVirtualTarget)
    ? (storyNavigation?.directReturn?.targetId ?? null)
    : null;
  const resolvedReturnDestination = resolvedReturnTargetId
    ? routeDestinationFromTarget(resolvedReturnTargetId, project, allMenus, allStories)
    : null;
  const resolvedReturnValue = resolvedReturnTargetId
    ? resolvedReturnSelectValueFromTarget(resolvedReturnTargetId, project)
    : null;
  const autoNextDestinationLabel = autoNextApplies
    ? (routeFinalDestination?.name || (autoNextResolution?.isLastStory ? (parentMenu?.name || t("tree:navigation.folder.fallback")) : t("tree:story.next.fallback")))
    : null;
  const returnEmptyResolvedLabel = autoNextApplies
    ? t("tree:story.autoNext.destination", { name: autoNextDestinationLabel })
    : inheritedReturnLabel;
  const returnDestinationHint = getNavigationSelectHint({
    value: node.returnAfterPlay,
    emptyResolvedLabel: returnEmptyResolvedLabel,
    entry: node,
    parentMenu,
    project,
  });
  const promptHomeSelectValue = node.afterPlaybackPromptHomeNone
    ? '__none__'
    : (node.afterPlaybackPromptHomeTarget ?? '');
  const promptAudioLabel = usesGlobalEndNodeAudio
    ? t("tree:story.endAudio.shared")
    : hasEndNode
      ? t("tree:story.endAudio.replacement")
      : t("tree:story.endAudio.local");
  const promptAudioDescription = usesGlobalEndNodeAudio
    ? t("tree:story.endAudio.sharedDescription")
    : hasEndNode
      ? t("tree:story.endAudio.replacementDescription")
      : autoNextApplies
        ? t("tree:story.endAudio.autoNextDescription")
        : t("tree:story.endAudio.description");
  const addPromptTooltip = hasEndNode
    ? t("tree:story.endAudio.overrideHint")
    : t("tree:story.endAudio.hint");
  const addSequenceTooltip = hasEndNode
    ? t("tree:story.sequence.overrideHint")
    : t("tree:story.sequence.hint");
  const advancedTitle = hasEndNode
    ? t("tree:story.endAudio.customTitle")
    : t("tree:story.disclosure.label");
  const advancedDescription = hasEndNode
      ? t("tree:story.endAudio.defaultDescription")
      : t("tree:story.endAudio.advancedDescription");
  const localDraftApplicability = localDraft
    ? getLocalEndDraftApplicability({
      draft: localDraft,
      entry: node,
      parentMenu,
      project,
    })
    : null;

  useEffect(() => {
    setShowSequenceEditor(false);
    setShowPromptField(false);
    setLocalDraft(null);
    setShowAdvanced(false);
  }, [node?.id]);

  async function clearEndAfterPlayback() {
    if (rawHasPrompt || rawHasSequence) {
      const confirmed = await showConfirmDialog({
        title: <TreeText messageKey="tree:story.delete.confirmTitle" />,
        message: { key: "tree:story.endAudio.confirmDelete" },
        okLabel: <TreeText messageKey="common:dialog.delete.label" />,
        okKind: 'danger',
      });
      if (!confirmed) return;
    }
    onUpdate({
      afterPlaybackPromptAudio: null,
      afterPlaybackPromptOkTarget: null,
      afterPlaybackPromptHomeTarget: null,
      afterPlaybackPromptHomeNone: false,
      afterPlaybackSequence: [],
      afterPlaybackHomeStep: null,
    });
    setShowSequenceEditor(false);
    setShowPromptField(false);
  }

  function startSequence() {
    const firstStep = normalizeSequenceStep({
      name: t("tree:story.sequence.firstName"),
      controlSettings: { ...SEQUENCE_CONTROL_DEFAULTS, autoplay: true, ok: true },
    }, 0);
    onUpdate({
      afterPlaybackSequence: [firstStep],
      afterPlaybackPromptAudio: null,
      afterPlaybackPromptOkTarget: null,
      afterPlaybackPromptHomeTarget: null,
      afterPlaybackPromptHomeNone: false,
    });
    setShowSequenceEditor(true);
    setShowPromptField(false);
  }

  function startLocalDraft() {
    setLocalDraft(createLocalEndDraft(project));
  }

  async function pickLocalDraftAudio() {
    const source = await pickAudio();
    if (!source) return;
    setLocalDraft((draft) => selectLocalEndDraftAudio(draft, source));
  }

  async function applyLocalDraft() {
    if (!localDraft || !localDraftApplicability?.applicable) return;
    const fields = await materializeLocalEndDraftFields({
      draft: localDraft,
      entry: node,
      parentMenu,
      project,
      importFile: onImportFile,
    });
    if (!fields) return;
    onUpdate(fields);
    setLocalDraft(null);
  }

  function updateAutoContinuation(enabled) {
    onUpdate({
      controlSettings: {
        ...storyControls,
        autoplay: enabled,
        ok: !enabled,
      },
      ...(enabled ? {} : { returnAfterPlay: null }),
    });
  }

  const playbackEndMode = autoContinuationEnabled ? 'auto' : 'stay';
  const returnDestinationLabel = routeFinalDestination?.name
    || destinationHintLabel(returnDestinationHint)
    || inheritedReturnLabel
    || t("tree:story.destination.chosenFallback");
  const returnDestinationType = routeFinalDestination?.type || routeTypeFromTarget(node.returnAfterPlay, project);
  const nightModeActive = !!project?.globalOptions?.nightMode;
  const routeUsesEndStep = !!effectiveEndBehavior?.usesEndStep;
  const routeFinalLabel = routeFinalDestination?.name || returnDestinationLabel;
  const routeFinalType = routeFinalDestination?.type || returnDestinationType;
  const routeEndStepLabel = hasSequence
    ? t("tree:story.sequence.title")
    : hasPrompt && !usesGlobalEndNodeAudio
      ? t("tree:story.endAudio.customTitle")
      : nightModeActive ? t("tree:multi.message.night", { name: project?.endNodeName || t("tree:endNode.card.title") }) : (project?.endNodeName || t("tree:endNode.card.title"));
  const routeContextText = autoNextApplies
    ? t("tree:story.autoNext.badge")
    : usesStorySpecificEndReturn
      ? t("tree:story.destination.override")
      : null;
  const showEndModeControls = !hasGeneratedEndNode && !autoNextApplies;
  const showReturnDestinationRow = !autoNextApplies && (
    usesStorySpecificEndReturn
    || (!hasGeneratedEndNode && autoContinuationEnabled)
  );
  const autoNextContextText = getAutoNextContextText(autoNextResolution);
  const afterPlayNotes = [
    autoNextContextText,
    autoNextApplies
      ? t("tree:story.autoNext.overrideDescription")
      : null,
  ].filter(Boolean);
  const showAfterPlayIntro = afterPlayNotes.length > 0;
  const showAdvancedControls = !autoNextApplies;

  // ─── Contenu "Message de fin" ────────────────────────────────────────────────

  let endContent;
  if (endMessage.presentationKind === 'global') {
    endContent = localDraft ? (
      <div className="end-simple-settings">
        <div className="sequence-note sequence-note--spaced">{t("tree:story.draft.description")}</div>
        <div className="field-row end-local-audio-row">
          <div style={{ flex: 1 }}>
            <span className="field-label">{t("tree:story.draft.audioLabel")}</span>
            <div className="after-play-muted">{localDraft.audio ? basename(localDraft.audio) : t("tree:story.draft.noAudio")}</div>
          </div>
          <Button size="sm" onClick={() => void pickLocalDraftAudio()}>{t("tree:story.draft.chooseAudio")}</Button>
          {localDraft.audio ? <Button size="sm" onClick={() => setLocalDraft((draft) => ({ ...draft, audio: null, audioSource: null }))}>{t("tree:story.draft.removeAudio")}</Button> : null}
        </div>
        <div className="sequence-targets">
          <div className="field-row field-row--flush">
            <span className="field-label">{t("tree:control.ok.label")}</span>
            <NavigationTargetSelect
              value={localDraft.okTarget ?? ''}
              onChange={(okTarget) => setLocalDraft((draft) => ({ ...draft, okTarget: okTarget || null }))}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              emptyLabel={t("tree:story.destination.inherited")}
            />
          </div>
          <div className="field-row field-row--flush">
            <span className="field-label">{t("tree:control.home.label")}</span>
            <NavigationTargetSelect
              value={localDraft.homeNone ? '__none__' : (localDraft.homeTarget ?? '')}
              onChange={(value) => setLocalDraft((draft) => value === '__none__'
                ? { ...draft, homeNone: true, homeTarget: null }
                : { ...draft, homeNone: false, homeTarget: value || null })}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              includeNone
              noneLabel={startReturnLabel}
              includeStoryPlay={false}
              emptyLabel={t("tree:story.home.followsOk")}
            />
          </div>
        </div>
        {!localDraftApplicability?.applicable ? (
          <div className="after-play-muted" role="status">{t("tree:story.draft.chooseHint")}</div>
        ) : null}
        <div className="end-actions-end">
          <Button size="sm" onClick={() => setLocalDraft(null)}>{t("common:dialog.cancel.label")}</Button>
          <Button
            size="sm"
            onClick={applyLocalDraft}
            disabled={!localDraftApplicability?.applicable}
          >{t("tree:story.draft.apply")}</Button>
        </div>
      </div>
    ) : (
      <div className="end-add-actions">
        <Tooltip text={addPromptTooltip} placement="above">
          <Button size="sm" onClick={startLocalDraft}>{t("tree:story.endAudio.add")}</Button>
        </Tooltip>
        <Tooltip text={addSequenceTooltip} placement="above">
          <Button size="sm" onClick={startSequence}>{t("tree:story.sequence.add")}</Button>
        </Tooltip>
      </div>
    );
  } else if (hasSequence) {
    endContent = (
      <>
        <div className="end-summary">
          <div>
            <div className="end-summary-title">
              <span>{t("tree:story.sequence.title")}</span>
              <span className="end-summary-badge">
                {t("tree:count.steps.label", { count: afterPlaybackSequence.length })}
              </span>
            </div>
            <div className="end-summary-copy">{t("tree:story.sequence.description")}</div>
          </div>
          <div className="end-summary-actions">
            {hasEndNode && (
              <Button size="sm" onClick={() => onAttachStoryEndToGlobal?.(node.id)}>{t("tree:endNode.global.attach")}</Button>
            )}
            <Tooltip text={showSequenceEditor ? t("tree:story.sequence.hide") : t("tree:story.sequence.show")}>
              <button
                type="button"
                className="sequence-summary-icon-btn"
                onClick={() => setShowSequenceEditor((v) => !v)}
                aria-label={showSequenceEditor ? t("tree:story.sequence.hide") : t("tree:story.sequence.show")}
              >
                {showSequenceEditor
                  ? <ChevronUp className="sequence-icon" />
                  : <ChevronDown className="sequence-icon" />}
              </button>
            </Tooltip>
            <Tooltip text={t("tree:story.sequence.remove")}>
              <button
                type="button"
                className="story-prompt-trash"
                onClick={clearEndAfterPlayback}
                aria-label={t("tree:story.sequence.remove")}
              >
                <Trash2 className="card-danger-icon" />
              </button>
            </Tooltip>
          </div>
        </div>
        {showSequenceEditor && (
          <EndSequenceEditor
            node={node}
            parentMenuId={parentMenu?.id ?? null}
            steps={afterPlaybackSequence}
            homeStep={afterPlaybackHomeStep}
            allMenus={allMenus}
            allStories={allStories}
            packStartReturnLabel={startReturnLabel}
            onUpdate={onUpdate}
          />
        )}
      </>
    );
  } else if (hasPrompt || showPromptField) {
    endContent = (
      <>
        <div className="end-field-head">
          <span className="field-label">{t("tree:story.endAudio.title")}</span>
          <Tooltip text={t("tree:story.endAudio.remove")}>
            <button
              type="button"
              className="story-prompt-trash"
              onClick={clearEndAfterPlayback}
              aria-label={t("tree:story.endAudio.remove")}
            >
              <Trash2 className="card-danger-icon" />
            </button>
          </Tooltip>
        </div>
        {hasEndNode && !usesGlobalEndNodeAudio && (
          <div className="sequence-note sequence-note--spaced">
            <Trans t={t} i18nKey="tree:story.endAudio.overrideNotice" components={{ strong: <strong /> }} />
          </div>
        )}
        <AudioField
          levelLabel={{ entry: node.name, step: '' }}
          label={promptAudioLabel}
          labelRef={{ key: usesGlobalEndNodeAudio ? "tree:story.endAudio.shared" : hasEndNode ? "tree:story.endAudio.replacement" : "tree:story.endAudio.local" }}
          description={promptAudioDescription}
          file={node.afterPlaybackPromptAudio}
          required={false}
          // eslint-disable-next-line i18next/no-literal-string -- repli technique du nom de fichier audio, pas un libellé UI
          ttsFilenameHint={`fin-${node.name || 'histoire'}`}
          xttsTarget={{ kind: 'story', entryId: node.id, field: 'afterPlaybackPromptAudio' }}
          onPick={(f) => onUpdate({ afterPlaybackPromptAudio: f })}
          onClear={() => onUpdate({
            afterPlaybackPromptAudio: null,
            afterPlaybackPromptOkTarget: null,
            afterPlaybackPromptHomeTarget: null,
            afterPlaybackPromptHomeNone: false,
          })}
        />
        {hasPrompt && (
          <div className="end-simple-settings">
            {hasEndNode && (
              <div className="sequence-note sequence-note--spaced">{t("tree:story.local.description")}</div>
            )}
            <div className="sequence-controls">
              {CONTROL_DEFS.map(({ key, label, def }) => (
                <label key={key} className="sequence-control">
                  <span>{t(label)}</span>
                  <Toggle
                    on={promptControls?.[key] ?? def}
                    onChange={(v) => onUpdate({
                      afterPlaybackPromptControlSettings: {
                        autoplay: promptControls.autoplay ?? true,
                        ok: promptControls.ok ?? true,
                        home: promptControls.home ?? true,
                        pause: promptControls.pause ?? false,
                        wheel: promptControls.wheel ?? false,
                        [key]: v,
                      },
                    })}
                  />
                </label>
              ))}
            </div>
            <div className="sequence-targets">
              <div className="field-row field-row--flush">
                <div style={{ flex: 1 }}>
                  <span className="field-label">{t("tree:control.ok.label")}</span>
                </div>
                <NavigationTargetSelect
                  value={node.afterPlaybackPromptOkTarget ?? ''}
                  onChange={(value) => onUpdate({ afterPlaybackPromptOkTarget: value })}
                  allMenus={allMenus}
                  allStories={allStories}
                  currentStoryId={node.id}
                  emptyLabel={t("tree:story.destination.inherited")}
                />
              </div>
              <div className="field-row field-row--flush">
                <div style={{ flex: 1 }}>
                  <span className="field-label">{t("tree:control.home.label")}</span>
                </div>
                <NavigationTargetSelect
                  value={promptHomeSelectValue}
                  onChange={(value) => {
                    if (value === '__none__') {
                      onUpdate({ afterPlaybackPromptHomeNone: true, afterPlaybackPromptHomeTarget: null });
                    } else {
                      onUpdate({ afterPlaybackPromptHomeNone: false, afterPlaybackPromptHomeTarget: value });
                    }
                  }}
                  allMenus={allMenus}
                  allStories={allStories}
                  currentStoryId={node.id}
                  includeNone
                  noneLabel={startReturnLabel}
                  emptyLabel={t("tree:story.home.followsOk")}
                  includeStoryPlay={false}
                />
              </div>
            </div>
            <div className="end-actions-end">
              {hasEndNode && (
                <Button size="sm" onClick={() => onAttachStoryEndToGlobal?.(node.id)}>{t("tree:endNode.global.attach")}</Button>
              )}
              <Button size="sm" onClick={startSequence}>{t("tree:story.sequence.convert")}</Button>
            </div>
          </div>
        )}
      </>
    );
  } else {
    endContent = (
      <div className="end-add-actions">
        <Tooltip text={addPromptTooltip} placement="above">
          <Button size="sm" onClick={() => setShowPromptField(true)}>{t("tree:story.endAudio.add")}</Button>
        </Tooltip>
        <Tooltip text={addSequenceTooltip} placement="above">
          <Button size="sm" onClick={startSequence}>{t("tree:story.sequence.add")}</Button>
        </Tooltip>
      </div>
    );
  }

  // ─── Rendu principal ────────────────────────────────────────────────────────

  return (
    <div className="card">
      <div className="card-title-row">
        <div className="card-title">{t("tree:playback.after.title")}</div>
        <div className="card-copy card-copy--inline">{t("tree:story.after.description")}</div>
      </div>

      {(showAfterPlayIntro || showEndModeControls) ? (
        <div className="after-play-main-row">
          {showAfterPlayIntro ? (
            <div className="after-play-intro">
              {afterPlayNotes.map((note) => (
                <div key={note} className="after-play-context-note">{note}</div>
              ))}
            </div>
          ) : null}

          {showEndModeControls && (
            <div className="after-play-end-row">
              <span className="after-play-end-label">{t("tree:story.end.label")}</span>
              <div className="story-end-mode" role="group" aria-label={t("tree:story.end.aria")}>
                <button
                  type="button"
                  className={`story-end-mode-btn ${playbackEndMode === 'stay' ? 'is-active' : ''}`}
                  aria-pressed={playbackEndMode === 'stay'}
                  onClick={() => updateAutoContinuation(false)}
                >{t("tree:story.end.stay")}</button>
                <button
                  type="button"
                  className={`story-end-mode-btn ${playbackEndMode === 'auto' ? 'is-active' : ''}`}
                  aria-pressed={playbackEndMode === 'auto'}
                  onClick={() => updateAutoContinuation(true)}
                >{t("tree:story.end.continue")}</button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {showReturnDestinationRow && (
        <div className="after-play-destination-row">
          <div className="after-play-destination-copy">
            <span className="field-label">
              {usesStorySpecificEndReturn
                ? t("tree:story.destination.afterMessage")
                : autoNextApplies
                  ? t("tree:story.autoNext.exception")
                  : t("tree:story.destination.afterStory")}
            </span>
            <div className="after-play-muted">
              {usesStorySpecificEndReturn
                ? t("tree:story.destination.individualHint")
                : autoNextApplies
                ? t("tree:story.destination.autoNextHint")
                : t("tree:story.destination.description")}
            </div>
          </div>
          <div className="after-play-destination-select">
            <NavigationTargetSelect
              value={node.returnAfterPlay ?? ''}
              onChange={(target) => onUpdate({ returnAfterPlay: target || null })}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              allowCurrentStory={!parentMenu}
              emptyLabel={autoNextApplies ? t("tree:story.destination.autoNextFollow") : (inheritedReturnLabel || resolvedReturnDestination?.name || t("tree:navigation.destination.choose"))}
              resolvedDefaultValue={resolvedReturnValue}
              resolvedDefaultLabel={resolvedReturnDestination?.name}
              emptyKind={!autoNextApplies && inheritedReturnLabel ? inheritedReturnKind : undefined}
              resolvedDefaultKind={resolvedReturnDestination?.type}
              hideDefaultWhenResolved
            />
          </div>
        </div>
      )}

      <div className="after-play-route" ref={afterPlayRef}>
        <div className="after-play-route-head">
          <div className="after-play-route-title">{t("tree:story.route.title")}</div>
          {routeContextText ? (
            <div className="after-play-route-context">{routeContextText}</div>
          ) : null}
        </div>
        <div className="after-play-route-list">
          <RouteChip icon={<CircleStop />}>{t("tree:story.route.finished")}</RouteChip>
          <RouteArrow />
          {routeUsesEndStep ? (
            <>
              <RouteChip icon={<RouteTargetIcon type="end-node" nightMode={nightModeActive} />}>
                {routeEndStepLabel}
              </RouteChip>
              {routeFinalLabel ? (
                <>
                  <RouteArrow />
                  <RouteChip icon={<RouteTargetIcon type={routeFinalType} />} destination>{routeFinalLabel}</RouteChip>
                </>
              ) : null}
            </>
          ) : autoContinuationEnabled ? (
            <RouteChip icon={<RouteTargetIcon type={returnDestinationType} />} destination>{returnDestinationLabel}</RouteChip>
          ) : (
            <RouteChip icon={<Pause />}>{t("tree:story.route.waiting")}</RouteChip>
          )}
        </div>
      </div>

      {showAdvancedControls ? (
        <StoryDisclosure
          open={showAdvanced}
          onToggle={() => setShowAdvanced((v) => !v)}
        >
          <div className="story-advanced-row">
            <div className="story-advanced-copy">
              <div className="story-advanced-title">{advancedTitle}</div>
              <div className="story-advanced-desc">{advancedDescription}</div>
            </div>
          </div>

          {showAdvanced && (
            <div className="story-advanced-controls">
              <div>
                {endContent}
              </div>
            </div>
          )}
        </StoryDisclosure>
      ) : null}
    </div>
  );
}
