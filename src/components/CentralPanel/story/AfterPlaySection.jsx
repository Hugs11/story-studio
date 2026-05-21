import { useEffect, useState } from 'react';
import { AudioField } from '../AudioField';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import {
  decodeNavigationStoryId,
  isStoryHomeStepNavigationTarget,
  isStoryNavigationTarget,
  isStoryPlayNavigationTarget,
} from '../../../store/navigationTargets';
import {
  getDefaultPackEntryDestination,
  getGeneratedStoryNavigation,
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
import { FolderOpen, Moon, Music } from '../../icons/LucideLocal';

function mediaPathKey(value) {
  return typeof value === 'string'
    ? value.trim().replace(/^\\\\\?\\/, '').replace(/\\/g, '/').toLowerCase()
    : '';
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
  const hasEndNode = !!(project?.nightModeAudio || project?.globalOptions?.nightMode || project?.globalOptions?.endNode);
  const hasPrompt = !!node?.afterPlaybackPromptAudio;
  const usesGlobalEndNodeAudio = !!(
    hasEndNode
    && hasPrompt
    && mediaPathKey(node.afterPlaybackPromptAudio)
    && mediaPathKey(node.afterPlaybackPromptAudio) === mediaPathKey(project?.nightModeAudio)
  );
  const afterPlaybackSequence = (node.afterPlaybackSequence ?? []).map(normalizeSequenceStep);
  const afterPlaybackHomeStep = node.afterPlaybackHomeStep
    ? normalizeSequenceStep(node.afterPlaybackHomeStep, 0)
    : null;

  // Quand l'histoire passe par le nœud de fin, on calcule sa destination finale
  // réellement générée pour cette histoire précise. On utilise `effectiveTargetId`
  // qui reflète le fallback Rust `compute_night_bridge_targets` quand
  // `nightModeReturn` est vide (retombée sur le retour propre de l'histoire).
  const endNodeFinalDestination = (() => {
    if (!hasEndNode || node?.type !== 'story') return null;
    const navigation = getGeneratedStoryNavigation(node, parentMenu, project, project?.rootEntries ?? []);
    if (!navigation.endNodeReturn.isActive) return null;
    const targetId = navigation.endNodeReturn.effectiveTargetId;
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
  })();
  const hasSequence = afterPlaybackSequence.length > 0;
  const hasAdvancedContent = hasPrompt || hasSequence;

  const [showAdvanced, setShowAdvanced] = useState(hasAdvancedContent);
  const [showSequenceEditor, setShowSequenceEditor] = useState(false);
  const [showPromptField, setShowPromptField] = useState(false);

  const promptControls = node.afterPlaybackPromptControlSettings ?? {};
  const promptHomeSelectValue = node.afterPlaybackPromptHomeNone
    ? '__none__'
    : (node.afterPlaybackPromptHomeTarget ?? '');
  const promptAudioLabel = usesGlobalEndNodeAudio
    ? 'Audio du nœud de fin'
    : hasEndNode
      ? 'Audio de remplacement'
      : 'Audio de fin';
  const promptAudioDescription = usesGlobalEndNodeAudio
    ? "Cette histoire utilise l'audio commun défini dans le Nœud de fin du pack."
    : hasEndNode
      ? "Joué à la place du nœud de fin pour cette histoire"
      : "Joué à la fin de l'histoire";
  const addPromptTooltip = hasEndNode
    ? "Pour cette histoire uniquement : un seul audio joué à la fin, à la place du nœud de fin du pack."
    : "Un seul audio joué à la fin (ex : « Bravo, l'histoire est finie ! »)";
  const addSequenceTooltip = hasEndNode
    ? "Pour cette histoire uniquement : plusieurs étapes audio enchaînées à la place du nœud de fin du pack."
    : 'Plusieurs étapes audio enchaînées (ex : question → réponse → conclusion)';
  const advancedTitle = hasEndNode
    ? 'Personnaliser pour cette histoire'
    : 'Message audio après cette histoire';
  const advancedDescription = hasEndNode
    ? "Remplacer le nœud de fin du pack par un audio spécifique pour cette histoire seulement. La plupart des packs n'en ont pas besoin."
    : 'Audio facultatif joué juste après cette histoire — par exemple un mot, une morale, ou une transition vers la suivante.';
  const advancedCollapsedLabel = hasEndNode ? 'Réglages avancés' : 'Configurer';

  useEffect(() => {
    if (hasPrompt || hasSequence) {
      setShowAdvanced(true);
    }
  }, [node?.id]);

  useEffect(() => {
    setShowSequenceEditor(false);
    setShowPromptField(false);
    setShowAdvanced(
      !!(node?.afterPlaybackPromptAudio) ||
      (node?.afterPlaybackSequence ?? []).length > 0,
    );
  }, [node?.id]);

  function clearEndAfterPlayback() {
    if (hasPrompt || hasSequence) {
      if (!window.confirm('Supprimer le message de fin de cette histoire ?')) return;
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
              Séquence jouée après la fin de l'histoire, avant le retour au menu.
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
            {usesGlobalEndNodeAudio ? 'Message du nœud de fin importé' : 'Message audio de fin'}
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
            Cette histoire jouera ce message <strong>à la place</strong> du nœud de fin du pack.
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
                Ce message vient du nœud de fin importé. Remplacer l'audio ici personnalisera uniquement cette histoire.
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
                  emptyLabel="Comportement par défaut"
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
      <div className="card-title">Après la lecture</div>

      {/* Destination de retour */}
      {allMenus.length > 0 && !hasEndNode && (
        <div className="field-row" style={{ marginTop: 10, alignItems: 'flex-start' }}>
          <div style={{ flex: 1 }}>
            <span className="field-label">À la fin de l'histoire, retour vers</span>
            <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginTop: 2 }}>
              Où l'enfant atterrit quand l'histoire se termine. Par défaut, suit le réglage du dossier parent.
            </div>
          </div>
          <div style={{ maxWidth: 220, width: '100%' }}>
          <NavigationTargetSelect
            value={node.returnAfterPlay ?? ''}
            onChange={(target) => onUpdate({ returnAfterPlay: target || null })}
            allMenus={allMenus}
            allStories={allStories}
            currentStoryId={node.id}
            emptyLabel={inheritedReturnLabel}
            includeRoot={false}
            includeStoryPlay={false}
          />
          <NavigationHint
            label={getNavigationSelectHint({
              value: node.returnAfterPlay,
              emptyResolvedLabel: inheritedReturnLabel,
              entry: node,
              parentMenu,
              project,
              allMenus,
              allStories,
            })}
          />
          </div>
        </div>
      )}

      {hasEndNode && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', flexWrap: 'wrap' }}>
          <span className="field-label">Destination</span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              padding: '4px 10px',
              borderRadius: 8,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <Moon style={{ width: 14, height: 14 }} /> Passe par le nœud de fin du pack
          </span>
          {endNodeFinalDestination && (
            <>
              <span style={{ color: 'var(--color-text-tertiary)', fontSize: 14 }}>→</span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  padding: '4px 10px',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {endNodeFinalDestination.type === 'story'
                  ? <Music style={{ width: 14, height: 14 }} />
                  : <FolderOpen style={{ width: 14, height: 14 }} />}
                {endNodeFinalDestination.name}
              </span>
            </>
          )}
        </div>
      )}

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
    </div>
  );
}
