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
  getGeneratedStoryNavigation,
} from '../../../store/generatedNavigation';
import {
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
import { IconArchive, IconFolderOpen, IconHouse, IconMoon, IconStop, IconStory } from '../../TreePanel/TreeIcons';
import { useErrorDialog } from '../../common/Dialog';
import { useProjectActions } from '../../../store/ProjectActionsContext';
import { useProjectContext } from '../../../store/ProjectContext';
import { pickAudio } from '../../../hooks/useFileDialog';
import { basename } from '../../../utils/fileUtils';
import { buildLocalEndDraftFields, createLocalEndDraft, selectLocalEndDraftAudio } from '../../../store/localEndDraft';
import { getEffectiveEndMessageControlState } from '../../../store/endMessagePresentation';

function destinationHintLabel(label) {
  if (!label) return null;
  return String(label)
    .replace(/^Retour vers /, '')
    .replace(/^Lecture de /, '')
    .trim();
}

function RouteChip({ icon = null, children, destination = false }) {
  return (
    <span className={`after-play-route-chip${destination ? ' is-destination' : ''}`}>
      {icon ? <span className="after-play-route-icon">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}

function RouteArrow() {
  return <span className="after-play-route-arrow" aria-hidden="true">→</span>;
}

function RouteTargetIcon({ type, nightMode = false }) {
  if (type === 'story') return <IconStory />;
  if (type === 'zip') return <IconArchive />;
  if (type === 'root') return <IconHouse />;
  if (type === 'end-node') return nightMode ? <IconMoon /> : <IconStop />;
  return <IconFolderOpen />;
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
    if (!defaultDest) return { name: NAV_ROOT_LABEL, type: 'menu' };
    return { name: defaultDest.name, type: defaultDest.type };
  }
  if (isStoryNavigationTarget(targetId)) {
    const storyId = decodeNavigationStoryId(targetId);
    const story = allStories.find((s) => s.id === storyId);
    const prefix = isStoryPlayNavigationTarget(targetId)
      ? 'Lecture directe - '
      : isStoryHomeStepNavigationTarget(targetId)
        ? 'Retour de fin - '
        : '';
    return { name: `${prefix}${story?.name ?? 'Histoire'}`, type: 'story' };
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
      ? "Auto-next est activé dans les options du pack : la sortie automatique lance directement l'histoire suivante."
      : "Auto-next est activé dans les options du pack : aucune histoire suivante, la sortie automatique revient au dossier.";
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
  onUpdate,
  afterPlayFocus = null,
  onAfterPlayFocusConsumed,
}) {
  const { showConfirmDialog } = useErrorDialog();
  const { onSelect, onAttachStoryEndToGlobal } = useProjectActions();
  const { onImportFile } = useProjectContext();
  const autoNextEnabled = !!project?.globalOptions?.autoNext;
  const hasEndNode = !!(!autoNextEnabled && (project?.nightModeAudio || project?.globalOptions?.nightMode || project?.globalOptions?.endNode));
  const rawHasPrompt = !!node?.afterPlaybackPromptAudio;
  const hasPrompt = rawHasPrompt && !autoNextEnabled;
  const afterPlaybackSequence = (node.afterPlaybackSequence ?? []).map(normalizeSequenceStep);
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
  const endMessageControls = endMessage.controls ?? {};
  const endMessageControlState = getEffectiveEndMessageControlState(endMessageControls, endMessage.effectiveHome);
  const usesGlobalEndNodeAudio = endMessage.presentationKind === 'global';
  const hasGeneratedEndNode = usesGlobalEndNodeAudio;
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
    ? (routeFinalDestination?.name || (autoNextResolution?.isLastStory ? (parentMenu?.name || 'ce dossier') : "l'histoire suivante"))
    : null;
  const returnEmptyResolvedLabel = autoNextApplies
    ? `Auto-next : ${autoNextDestinationLabel}`
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
    ? 'Audio du message de fin'
    : hasEndNode
      ? 'Audio de remplacement'
      : 'Audio de fin';
  const promptAudioDescription = usesGlobalEndNodeAudio
    ? "Cette histoire utilise l'audio commun défini dans le message de fin du pack."
    : hasEndNode
      ? "Joué à la place du message de fin pour cette histoire"
      : autoNextApplies
        ? "Joué à la fin de l'histoire, avant la destination auto-next"
        : "Joué à la fin de l'histoire";
  const addPromptTooltip = hasEndNode
    ? "Pour cette histoire uniquement : un seul audio joué à la fin, à la place du message de fin du pack."
    : "Un seul audio joué à la fin (ex : « Bravo, l'histoire est finie ! »)";
  const addSequenceTooltip = hasEndNode
    ? "Pour cette histoire uniquement : plusieurs étapes audio enchaînées à la place du message de fin du pack."
    : 'Plusieurs étapes audio enchaînées (ex : question → réponse → conclusion)';
  const advancedTitle = hasEndNode
    ? 'Message de fin personnalisé'
    : 'Réglages avancés';
  const advancedDescription = hasEndNode
      ? 'Par défaut, cette histoire utilise le message de fin du pack.'
      : 'Options rarement nécessaires pour personnaliser la fin de cette histoire.';

  useEffect(() => {
    setShowSequenceEditor(false);
    setShowPromptField(false);
    setLocalDraft(null);
    setShowAdvanced(false);
  }, [node?.id]);

  async function clearEndAfterPlayback() {
    if (rawHasPrompt || rawHasSequence) {
      const confirmed = await showConfirmDialog({
        title: 'Confirmer la suppression',
        message: 'Supprimer le message de fin de cette histoire ?',
        okLabel: 'Supprimer',
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
      name: 'Étape 1',
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
    if (!localDraft) return;
    const audio = localDraft.audioSource
      ? (await onImportFile?.(localDraft.audioSource) ?? localDraft.audioSource)
      : localDraft.audio;
    const fields = buildLocalEndDraftFields(localDraft, audio);
    const candidate = getGeneratedStoryNavigation(
      { ...node, ...fields }, parentMenu, project, project?.rootEntries ?? [],
    );
    // Une destination explicite peut etre equivalente au `next_story` global.
    // Dans ce cas, il n'existe toujours pas de fin locale a materialiser.
    if (candidate.endMessage.presentationKind === 'global') return;
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
    || 'la destination choisie';
  const returnDestinationType = routeFinalDestination?.type || routeTypeFromTarget(node.returnAfterPlay, project);
  const nightModeActive = !!project?.globalOptions?.nightMode;
  const routeUsesEndStep = !!effectiveEndBehavior?.usesEndStep;
  const routeFinalLabel = routeFinalDestination?.name || returnDestinationLabel;
  const routeFinalType = routeFinalDestination?.type || returnDestinationType;
  const routeEndStepLabel = hasSequence
    ? 'Scénario de fin'
    : hasPrompt && !usesGlobalEndNodeAudio
      ? 'Message de fin personnalisé'
      : `${project?.endNodeName || 'Message de fin'}${nightModeActive ? ' (mode nuit)' : ''}`;
  const routeContextText = autoNextApplies
    ? 'Auto-next activé'
    : null;
  const showEndModeControls = !hasGeneratedEndNode && !autoNextApplies;
  const showReturnDestinationRow = !hasGeneratedEndNode
    && !autoNextApplies
    && autoContinuationEnabled;
  const autoNextContextText = getAutoNextContextText(autoNextResolution);
  const afterPlayNotes = [
    autoNextContextText,
    autoNextApplies
      ? 'Les retours personnalisés, le message de fin et les scénarios de fin restent dans le projet, mais auto-next prend la main.'
      : null,
  ].filter(Boolean);
  const showAfterPlayIntro = afterPlayNotes.length > 0;
  const showAdvancedControls = !autoNextApplies;

  // ─── Contenu "Message de fin" ────────────────────────────────────────────────

  let endContent;
  if (endMessage.presentationKind === 'global') {
    endContent = localDraft ? (
      <div className="end-simple-settings">
        <div className="sequence-note sequence-note--spaced">Brouillon de fin locale — il ne modifie pas encore cette histoire.</div>
        <div className="field-row">
          <div style={{ flex: 1 }}>
            <span className="field-label">Audio de la fin locale</span>
            <div className="after-play-muted">{localDraft.audio ? basename(localDraft.audio) : 'Aucun audio choisi'}</div>
          </div>
          <Button size="sm" onClick={() => void pickLocalDraftAudio()}>Choisir un audio</Button>
          {localDraft.audio ? <Button size="sm" onClick={() => setLocalDraft((draft) => ({ ...draft, audio: null, audioSource: null }))}>Retirer</Button> : null}
        </div>
        <div className="sequence-targets">
          <div className="field-row field-row--flush">
            <span className="field-label">Bouton OK</span>
            <NavigationTargetSelect
              value={localDraft.okTarget ?? ''}
              onChange={(okTarget) => setLocalDraft((draft) => ({ ...draft, okTarget: okTarget || null }))}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              emptyLabel="Comme à la fin de l'histoire"
            />
          </div>
          <div className="field-row field-row--flush">
            <span className="field-label">Bouton Accueil</span>
            <NavigationTargetSelect
              value={localDraft.homeNone ? '__none__' : (localDraft.homeTarget ?? '')}
              onChange={(value) => setLocalDraft((draft) => value === '__none__'
                ? { ...draft, homeNone: true, homeTarget: null }
                : { ...draft, homeNone: false, homeTarget: value || null })}
              allMenus={allMenus}
              allStories={allStories}
              currentStoryId={node.id}
              includeNone
              includeStoryPlay={false}
              emptyLabel="Identique au bouton OK"
            />
          </div>
        </div>
        <div className="end-actions-end">
          <Button size="sm" onClick={() => setLocalDraft(null)}>Annuler</Button>
          <Button size="sm" onClick={applyLocalDraft}>Appliquer la fin locale</Button>
        </div>
      </div>
    ) : (
      <div className="end-summary">
        <div>
          <div className="end-summary-title">🌙 Utilise le message de fin du pack</div>
          <div className="end-summary-copy">
            Lecture : {endMessageControlState.playback === 'autoplay' ? 'enchaînement automatique' : endMessageControlState.playback === 'wait-ok' ? 'attend OK' : 'reste sur le message'} · {endMessageControlState.home === 'disabled' ? 'Accueil désactivé' : endMessageControlState.home === 'pack-start' ? 'Accueil → début du pack' : 'Accueil → destination configurée'} · Pause {endMessageControls.pause === false ? 'désactivée' : 'activée'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button size="sm" onClick={() => onSelect?.('end-node')}>Modifier le message du pack</Button>
          <Button size="sm" onClick={startLocalDraft}>Créer une fin locale</Button>
        </div>
      </div>
    );
  } else if (hasSequence) {
    endContent = (
      <>
        <div className="end-summary">
          <div>
            <div className="end-summary-title">
              <span>Scénario de fin</span>
              <span className="end-summary-badge">
                {afterPlaybackSequence.length} étape{afterPlaybackSequence.length > 1 ? 's' : ''}
              </span>
            </div>
            <div className="end-summary-copy">
              Séquence jouée après la fin de l'histoire, avant la destination suivante.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {hasEndNode && (
              <Button size="sm" onClick={() => onAttachStoryEndToGlobal?.(node.id)}>
                Rattacher au message du pack
              </Button>
            )}
            <Tooltip text={showSequenceEditor ? 'Masquer le scénario' : 'Afficher le scénario'}>
              <button
                type="button"
                className="sequence-summary-icon-btn"
                onClick={() => setShowSequenceEditor((v) => !v)}
                aria-label={showSequenceEditor ? 'Masquer le scénario' : 'Afficher le scénario'}
              >
                {showSequenceEditor
                  ? <ChevronUp className="sequence-icon" />
                  : <ChevronDown className="sequence-icon" />}
              </button>
            </Tooltip>
            <Tooltip text="Retirer le scénario de fin">
              <button
                type="button"
                className="story-prompt-trash"
                onClick={clearEndAfterPlayback}
                aria-label="Retirer le scénario de fin"
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
            onUpdate={onUpdate}
          />
        )}
      </>
    );
  } else if (hasPrompt || showPromptField) {
    endContent = (
      <>
        <div className="end-field-head">
          <span className="field-label">
            Message audio de fin
          </span>
          <Tooltip text="Retirer le message audio de fin">
            <button
              type="button"
              className="story-prompt-trash"
              onClick={clearEndAfterPlayback}
              aria-label="Retirer le message audio de fin"
            >
              <Trash2 className="card-danger-icon" />
            </button>
          </Tooltip>
        </div>
        {hasEndNode && !usesGlobalEndNodeAudio && (
          <div className="sequence-note sequence-note--spaced">
            Cette histoire jouera ce message <strong>à la place</strong> du message de fin du pack.
          </div>
        )}
        <AudioField
          accentLabel
          label={promptAudioLabel}
          description={promptAudioDescription}
          file={node.afterPlaybackPromptAudio}
          required={false}
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
              <div className="sequence-note sequence-note--spaced">
                Cette histoire utilise une fin locale à la place du message du pack.
              </div>
            )}
            <div className="sequence-controls">
              {CONTROL_DEFS.map(({ key, label, def }) => (
                <label key={key} className="sequence-control">
                  <span>{label}</span>
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
                  <span className="field-label">Bouton OK</span>
                </div>
                <NavigationTargetSelect
                  value={node.afterPlaybackPromptOkTarget ?? ''}
                  onChange={(value) => onUpdate({ afterPlaybackPromptOkTarget: value })}
                  allMenus={allMenus}
                  allStories={allStories}
                  currentStoryId={node.id}
                  emptyLabel="Comme à la fin de l'histoire"
                />
              </div>
              <div className="field-row field-row--flush">
                <div style={{ flex: 1 }}>
                  <span className="field-label">Bouton Accueil</span>
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
                  emptyLabel="Identique au bouton OK"
                  includeStoryPlay={false}
                />
              </div>
            </div>
            <div className="end-actions-end">
              {hasEndNode && (
                <Button size="sm" onClick={() => onAttachStoryEndToGlobal?.(node.id)}>
                  Rattacher au message du pack
                </Button>
              )}
              <Button size="sm" onClick={startSequence}>
                Convertir en scénario de fin
              </Button>
            </div>
          </div>
        )}
      </>
    );
  } else {
    endContent = (
      <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
        <Tooltip text={addPromptTooltip} placement="above">
          <Button size="sm" onClick={() => setShowPromptField(true)}>
            Ajouter un audio de fin
          </Button>
        </Tooltip>
        <Tooltip text={addSequenceTooltip} placement="above">
          <Button size="sm" onClick={startSequence}>
            Ajouter un scénario de fin
          </Button>
        </Tooltip>
      </div>
    );
  }

  // ─── Rendu principal ────────────────────────────────────────────────────────

  return (
    <div className="card">
      <div className="card-title-row">
        <div className="card-title">Après la lecture</div>
        <div className="card-copy card-copy--inline">
          Que se passe-t-il quand cette histoire se termine.
        </div>
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
              <span className="after-play-end-label">À la fin</span>
              <div className="story-end-mode" role="group" aria-label="Comportement à la fin de l'histoire">
                <button
                  type="button"
                  className={`story-end-mode-btn ${playbackEndMode === 'stay' ? 'is-active' : ''}`}
                  aria-pressed={playbackEndMode === 'stay'}
                  onClick={() => updateAutoContinuation(false)}
                >
                  Rester sur l'écran
                </button>
                <button
                  type="button"
                  className={`story-end-mode-btn ${playbackEndMode === 'auto' ? 'is-active' : ''}`}
                  aria-pressed={playbackEndMode === 'auto'}
                  onClick={() => updateAutoContinuation(true)}
                >
                  Enchaîner
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}

      {showReturnDestinationRow && (
        <div className="after-play-destination-row">
          <div className="after-play-destination-copy">
            <span className="field-label">
              {autoNextApplies ? 'Exception à auto-next' : "Destination après l'histoire"}
            </span>
            <div className="after-play-muted">
              {autoNextApplies
                ? 'Laisser vide pour suivre le comportement auto-next global.'
                : "L'écran ou le menu affiché à la sortie automatique."}
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
              emptyLabel={autoNextApplies ? 'Suit auto-next global' : (inheritedReturnLabel || resolvedReturnDestination?.name || 'Choisir une destination')}
              resolvedDefaultValue={resolvedReturnValue}
              resolvedDefaultLabel={resolvedReturnDestination?.name}
              resolvedDefaultKind={resolvedReturnDestination?.type}
              hideDefaultWhenResolved
            />
          </div>
        </div>
      )}

      <div className="after-play-route" ref={afterPlayRef}>
        <div className="after-play-route-head">
          <div className="after-play-route-title">Résumé du parcours</div>
          {routeContextText ? (
            <div className="after-play-route-context">{routeContextText}</div>
          ) : null}
        </div>
        <div className="after-play-route-list">
          <RouteChip icon={<CircleStop />}>Histoire terminée</RouteChip>
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
            <RouteChip icon={<Pause />}>Attente sur l'écran</RouteChip>
          )}
        </div>
      </div>

      {endMessage.presentationKind === 'global' ? (
        <div className="story-advanced-controls">{endContent}</div>
      ) : showAdvancedControls ? (
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
