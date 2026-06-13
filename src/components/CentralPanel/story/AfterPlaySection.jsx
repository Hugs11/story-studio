import { useEffect, useState } from 'react';
import { AudioField } from '../AudioField';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import {
  decodeNavigationStoryId,
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
  CONTROL_DEFS,
  SEQUENCE_CONTROL_DEFAULTS,
  NavigationHint,
  NavigationTargetSelect,
  getNavigationSelectHint,
  NAV_ROOT_LABEL,
  normalizeSequenceStep,
} from './storyUtils';
import { EndSequenceEditor } from './EndSequenceEditor';
import { CircleStop, Pause } from '../../icons/LucideLocal';
import { IconArchive, IconFolderOpen, IconHouse, IconMoon, IconStop, IconStory } from '../../TreePanel/TreeIcons';
import { useErrorDialog } from '../../common/Dialog';
import { pathKey } from '../../../utils/fileUtils';

function destinationHintLabel(label) {
  if (!label) return null;
  return String(label)
    .replace(/^Retour vers /, '')
    .replace(/^Lecture de /, '')
    .trim();
}

function RouteChip({ icon = null, children }) {
  return (
    <span className="after-play-route-chip">
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

function getAutoNextContextText(autoNextResolution) {
  if (!autoNextResolution?.enabled) return null;
  if (autoNextResolution.applies) {
    return autoNextResolution.hasNextStory
      ? "Auto-next est activé dans les options du pack : la destination par défaut est la lecture directe de l'histoire suivante."
      : "Auto-next est activé dans les options du pack : aucune histoire suivante, la destination par défaut revient au dossier.";
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
}) {
  const { showConfirmDialog } = useErrorDialog();
  const autoNextEnabled = !!project?.globalOptions?.autoNext;
  const hasEndNode = !!(!autoNextEnabled && (project?.nightModeAudio || project?.globalOptions?.nightMode || project?.globalOptions?.endNode));
  const rawHasPrompt = !!node?.afterPlaybackPromptAudio;
  const hasPrompt = rawHasPrompt && !autoNextEnabled;
  const usesGlobalEndNodeAudio = !!(
    hasEndNode
    && hasPrompt
    && pathKey(node.afterPlaybackPromptAudio)
    && pathKey(node.afterPlaybackPromptAudio) === pathKey(project?.nightModeAudio)
  );
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
  const hasGeneratedEndNode = !!storyNavigation?.endNodeReturn?.isActive;
  const autoNextResolution = effectiveEndBehavior?.autoNext ?? null;
  const autoNextApplies = !!autoNextResolution?.applies;

  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSequenceEditor, setShowSequenceEditor] = useState(false);
  const [showPromptField, setShowPromptField] = useState(false);

  const promptControls = node.afterPlaybackPromptControlSettings ?? {};
  const storyControls = node.controlSettings ?? {};
  const hasExplicitReturnTarget = !!node.returnAfterPlay;
  const localAutoContinuationEnabled = !!(storyControls.autoplay || hasExplicitReturnTarget);
  const autoContinuationEnabled = !!effectiveEndBehavior?.autoContinuation;
  const routeFinalTargetId = effectiveEndBehavior?.finalTargetId ?? null;
  const routeFinalDestination = routeDestinationFromTarget(routeFinalTargetId, project, allMenus, allStories);
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
    allMenus,
    allStories,
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
    ? 'Remplacer le message de fin pour cette histoire'
    : 'Réglages avancés';
  const advancedDescription = hasEndNode
      ? "Par défaut, le message de fin est utilisé. Vous pouvez en mettre un spécifique à cette histoire uniquement."
      : 'Options rarement nécessaires pour personnaliser la fin de cette histoire.';
  const advancedCollapsedLabel = hasEndNode ? 'Réglages avancés' : 'Configurer';

  useEffect(() => {
    setShowSequenceEditor(false);
    setShowPromptField(false);
    setShowAdvanced(false);
  }, [node?.id]);

  async function clearEndAfterPlayback() {
    if (rawHasPrompt || rawHasSequence) {
      const confirmed = await showConfirmDialog({
        title: 'Confirmer la suppression',
        message: 'Supprimer le message de fin de cette histoire ?',
        okLabel: 'Supprimer',
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

  function updateAutoContinuation(enabled) {
    onUpdate({
      controlSettings: { ...storyControls, autoplay: enabled },
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
  const showReturnDestinationRow = allMenus.length > 0
    && !hasGeneratedEndNode
    && !autoNextApplies
    && (localAutoContinuationEnabled || autoNextApplies);
  const autoNextContextText = getAutoNextContextText(autoNextResolution);
  const showAdvancedControls = !autoNextApplies;

  // ─── Contenu "Message de fin" ────────────────────────────────────────────────

  let endContent;
  if (hasSequence) {
    endContent = (
      <>
        <div className="end-summary">
          <div>
            <div className="end-summary-title">
              Scénario de fin — {afterPlaybackSequence.length} étape{afterPlaybackSequence.length > 1 ? 's' : ''}
            </div>
            <div className="end-summary-copy">
              Séquence jouée après la fin de l'histoire, avant la destination suivante.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn-xs" onClick={() => setShowSequenceEditor((v) => !v)}>
              {showSequenceEditor ? 'Masquer' : 'Modifier'}
            </button>
            <button
              type="button"
              className="btn-xs"
              style={{ color: '#E24B4A', borderColor: '#E24B4A' }}
              onClick={clearEndAfterPlayback}
            >
              Retirer
            </button>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <span className="field-label">
            {usesGlobalEndNodeAudio ? 'Message de fin importé' : 'Message audio de fin'}
          </span>
          <button
            type="button"
            className="btn-xs"
            style={{ color: '#E24B4A', borderColor: '#E24B4A' }}
            onClick={clearEndAfterPlayback}
          >
            Retirer
          </button>
        </div>
        {hasEndNode && !usesGlobalEndNodeAudio && (
          <div className="sequence-note" style={{ marginBottom: 10 }}>
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
            {usesGlobalEndNodeAudio && (
              <div className="sequence-note" style={{ marginBottom: 10 }}>
                Ce message vient du message de fin importé. Remplacer l'audio ici personnalisera uniquement cette histoire.
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
              <div className="field-row" style={{ marginBottom: 0 }}>
                <div style={{ flex: 1 }}>
                  <span className="field-label">Bouton OK</span>
                </div>
                <NavigationTargetSelect
                  value={node.afterPlaybackPromptOkTarget ?? ''}
                  onChange={(value) => onUpdate({ afterPlaybackPromptOkTarget: value })}
                  allMenus={allMenus}
                  allStories={allStories}
                  currentStoryId={node.id}
                  emptyLabel="Même destination que la fin d'histoire"
                />
              </div>
              <div className="field-row" style={{ marginBottom: 0 }}>
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
                />
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="button" className="btn-xs" onClick={startSequence}>
                Convertir en scénario de fin
              </button>
            </div>
          </div>
        )}
      </>
    );
  } else {
    endContent = (
      <div style={{ display: 'flex', gap: 8, padding: '4px 0' }}>
        <Tooltip text={addPromptTooltip} placement="above">
          <button type="button" className="btn-xs" onClick={() => setShowPromptField(true)}>
            Ajouter un audio de fin
          </button>
        </Tooltip>
        <Tooltip text={addSequenceTooltip} placement="above">
          <button type="button" className="btn-xs" onClick={startSequence}>
            Ajouter un scénario de fin
          </button>
        </Tooltip>
      </div>
    );
  }

  // ─── Rendu principal ────────────────────────────────────────────────────────

  return (
    <div className="card">
      <div className="card-title">À la fin de l'histoire</div>

      <div className="after-play-main-row">
        <div className="after-play-intro">
          <div className="after-play-question">Que se passe-t-il à la fin de l'histoire ?</div>
          <div className="after-play-answer">
            {hasGeneratedEndNode
              ? 'Un message de fin est joué automatiquement avant de passer à la destination effective.'
              : hasSequence
                ? 'Le scénario de fin est joué automatiquement avant de passer à la destination effective.'
                : hasPrompt
                  ? 'Le message de fin personnalisé est joué automatiquement avant de passer à la destination effective.'
                  : autoNextApplies
                    ? 'Auto-next applique une destination automatique définie par la position de cette histoire dans le dossier.'
              : autoContinuationEnabled
                ? "La Lunii peut s'arrêter et attendre, ou enchaîner automatiquement vers la destination choisie."
                : "La Lunii s'arrête et reste sur l'écran de l'histoire. L'enfant doit appuyer sur un bouton pour continuer."}
          </div>
          {autoNextContextText ? (
            <div className="after-play-context-note">{autoNextContextText}</div>
          ) : null}
          {autoNextApplies ? (
            <div className="after-play-context-note">
              Les retours personnalisés, le message de fin et les scénarios de fin sont conservés dans le projet, mais ignorés tant qu'auto-next est actif.
            </div>
          ) : null}
        </div>

        {showEndModeControls && (
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
        )}
      </div>

      <div className="after-play-route">
        <div className="after-play-route-head">
          <div className="after-play-route-title">Parcours réel sur la Lunii</div>
          {routeContextText ? (
            <div className="after-play-route-context">{routeContextText}</div>
          ) : null}
        </div>
        <div className="after-play-route-list">
          <RouteChip icon={<CircleStop />}>Fin de l'histoire</RouteChip>
          <RouteArrow />
          {routeUsesEndStep ? (
            <>
              <RouteChip icon={<RouteTargetIcon type="end-node" nightMode={nightModeActive} />}>
                {routeEndStepLabel}
              </RouteChip>
              {routeFinalLabel ? (
                <>
                  <RouteArrow />
                  <RouteChip icon={<RouteTargetIcon type={routeFinalType} />}>{routeFinalLabel}</RouteChip>
                </>
              ) : null}
            </>
          ) : autoContinuationEnabled ? (
            <RouteChip icon={<RouteTargetIcon type={returnDestinationType} />}>{returnDestinationLabel}</RouteChip>
          ) : (
            <RouteChip icon={<Pause />}>Attente sur l'écran</RouteChip>
          )}
        </div>
      </div>

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
              emptyLabel={returnEmptyResolvedLabel}
              includeRoot={false}
              includeStoryPlay={false}
            />
            <NavigationHint label={returnDestinationHint} />
          </div>
        </div>
      )}

      {showAdvancedControls ? (
        <>
          {/* Options avancées : message de fin + bouton Accueil */}
          <div className="advanced-toggle-row">
            <div className="advanced-toggle-copy">
              <div className="field-label">{advancedTitle}</div>
              <div className="advanced-toggle-desc">
                {advancedDescription}
              </div>
            </div>
            <button
              type="button"
              className={`btn advanced-toggle-btn ${showAdvanced ? 'is-active' : ''}`}
              aria-expanded={showAdvanced}
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? 'Masquer' : advancedCollapsedLabel}
            </button>
          </div>

          {showAdvanced && (
            <div
              style={{
                marginTop: 10,
                padding: '10px 12px',
                borderRadius: 12,
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.06)',
                display: 'grid',
                gap: 12,
              }}
            >
              <div>
                {endContent}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
